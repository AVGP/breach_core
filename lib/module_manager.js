/*
 * Breach: module_manager.js
 *
 * Copyright (c) 2014, Stanislas Polu. All rights reserved.
 *
 * @author: spolu
 *
 * @log:
 * 2013-13-14 spolu   Creation
 * 2014-01-08 spolu   Improved interface
 */
var async = require('async');
var fs = require('fs-extra');
var child_process = require('child_process');
var https = require('https');
var mkdirp = require('mkdirp');
var events = require('events');
var github = require('octonode');
var nedb = require('nedb');
var npm = require('npm');
var semver = require('semver');
var zlib = require('zlib');
var request = require('request');


var api = require('exo_browser');

var common = require('./common.js');

// ## module_manager
//
// This is the module management class. It exposes methods to init the module
// registry (local for now), search, add, install, remove and start modules.
//
// It also handles the communication between modules (events & RPC) and exposes
// hooks for Breach to expose the `breach/core` module.
//
// A module manager is associated with a session and manages all the running
// modules for that session.
//
// Module IDs are local path or github URLs.
//
// Module description format:
// ```
// {
//   type: 'github'|'local',
//   owner: {author}|'local',
//   name: {name},
//   tag: {tag},
//   path: 'local:...'|'github:...'
//   version: {version},
//   active: true|false
// }
// ```
//
// API:
// ```
//  add {path}
//  install {path} /* must be added first. */
//  list
//  stop {path}
//  remove {path}
//  info {path}
//  ```
//
//
// The module manager handles a dictionary of running module stored in
// `my.running_modules` with the given structure:
// ```
// my.running_modules[path] = {
//   process: null,
//   path: path,
//   restart: 0,
//   registrations: [],
//   status: 'running'
// }
// ```
//
// ```
// @spec { session }
// ```
var module_manager = function(spec, my) {
  var _super = {};
  my = my || {};
  spec = spec || {};

  my.session = spec.session;

  /* The `modules_path` is the repository of public modules installed on this */
  /* machine. Modules are shared among users of a same machine.               */
  my.modules_path = require('path').join(api.data_path('breach'), 'modules');
  /* The `session_data_path` if not null (off_the_record), is used to store */
  /* and retrieve the modules information for the associated session.       */
  my.session_data_path = my.session.off_the_record() ? null : 
    require('path').join(my.session.data_path(), 'modules.db');

  my.db = null;
  my.github = github.client();

  my.running_modules = {};
  my.shutdown_modules = {};

  my.core_module = {
    path: 'internal:breach/core',
    name: 'core',
    procedures: {},
    message_id: 0,
    rpc_calls: {}
  };

  //
  // #### _public_
  // 
  var init;            /* init(cb_); */
  var kill;            /* stop(cb_); */

  var core_expose;     /* core_expose(proc, fun); */
  var core_call;       /* core_call(name, proc, args, cb_); */
  var core_emit;       /* core_emit(type, evt); */

  var add;             /* add(path, cb_) */
  var list;            /* list(cb_); */
  var install;         /* install(path, cb_); */
  var remove;          /* remove(path, cb_); */

  //var info;            /* info(path, cb_); */
  //var update;          /* update(path, cb_); */

  var run_module;      /* run_module(path, cb_); */
  var kill_module;     /* kill_module(path, cb_); */

  //
  // #### _private_
  // 
  var expand_path;            /* expand_path(path); */
  var augment_path;           /* augment_path(path, cb_); */
  var storage_path;           /* storage_path(path); */

  var dispatch;               /* dispatch(module, msg); */


  //
  // #### _that_
  //
  var that = new events.EventEmitter();

  /****************************************************************************/
  /* PRIVATE HELPERS */
  /****************************************************************************/
  // ### expand_path
  //
  // Transforms a path string into a parsed object
  // ```
  // @path {string} a module path
  // ```
  expand_path = function(path) {
    var github_r = 
      /^github\:([a-zA-Z0-9\-_\.]+)\/([a-zA-Z0-9\-_\.]+)(#[a-zA-Z0-9\-_\.]+){0,1}/;
    var github_m = github_r.exec(path);
    if(github_m) {
      return {
        type: 'github',
        owner: github_m[1],
        name: github_m[2],
        tag: github_m[3] ? github_m[3].substr(1) : null,
      }
    }
    var local_r = /^local\:(.+)$/
    var local_m = local_r.exec(path);
    if(local_m) {
      var home_r = /^~/;
      if(home_r.exec(local_m[1])) {
        /* Unix Only */
        return {
          type: 'local',
          path: require('path').join(process.env['HOME'], local_m[1].substr(1))
        }
      }
      return {
        type: 'local',
        path: require('path').normalize(local_m[1])
      };
    }
    return null;
  };

  // ### augment_path
  //
  // Augments a module path. If it's a local path, it checks that it exists and
  // does not do anything. If it's a github path, then it checks that the branch
  // exists. If no branch is specified, it tries to find the most appropriate
  // one
  // ```
  // @path {string} a module path
  // @cb_  {function(err, path)}
  // ```
  augment_path = function(path, cb_) {
    var p = expand_path(path);
    if(!p) {
      return cb_(common.err('Invalid module `path`: ' + path,
                            'module_manager:invalid_path'));
    }
    if(p.type === 'github') {
      var repo = my.github.repo(p.owner + '/' + p.name);
      repo.tags(function(err, data) {
        if(err) {
          return cb_(err);
        }
        var vers = [];
        var match = null;
        data.forEach(function(t) {
          var v = semver.clean(t.name, true);
          if(v) {
            vers.push({
              version: v,
              tag: t.name,
            });
          }
          if(p.tag === t.name) {
            match = {
              version: v,
              tag: t.name
            };
          }
        });
        vers.sort(function(a, b) {
          return semver.gt(b.version, a.version) ? 1 : 
            (semver.lt(b.version, a.version) ? -1 : 0);
        });
        if(match) {
          console.log(JSON.stringify(match, null, 2));
          return cb_(null, path);
        }
        else if(p.tag === 'master') {
          return cb_(null, p.type + ':' + p.owner + '/' + p.name + '#master');
        }
        else if(p.tag) {
          return cb_(common.err('Invalid `path` tag: ' + path,
                                'module_manager:invalid_path'));
        }
        else if(vers.length > 0) {
          return cb_(null,
                     p.type + ':' + p.owner + '/' + p.name + '#' + vers[0].tag);
        }
        else {
          return cb_(null, p.type + ':' + p.owner + '/' + p.name + '#master');
        }
      });
    }
    else if(p.type === 'local') {
      fs.stat(p.path, function(err, stat) {
        if(err) {
          return cb_(err);
        }
        return cb_(null, p.type + ':'  + p.path);
      });
    }
  };

  // ### storage_path
  //
  // Computes the local storage_path for a module given its path
  // ```
  // @path {string} a module path
  // ```
  storage_path = function(path) {
    var p = expand_path(path);
    if(!p) {
      return null;
    }
    switch(p.type) {
      case 'github': {
        return require('path').join(my.modules_path, 
                                    p.owner, p.name + '#' + p.tag);
        break;
      }
      case 'local': {
        return p.path;
        break;
      }
      default: {
        return null;
      }
    }
  };


  /****************************************************************************/
  /* MESSAGE DISPATCH */
  /****************************************************************************/
  // ### dispatch
  //
  // Dispatches a message received from a module to where it is supposed to go
  // There are three types of messages: 
  // `event`      : event emitted and dispatched to registered modules
  // `register`   : registers for some events
  // `unregister` : unregisters an existing registration
  // `rpc_call`   : remote procedure call directed to a module
  // `rpc_reply`  : reply from a remote procedure call
  // ```
  // @msg {object} the message to dispatch
  // ```
  dispatch = function(msg) {
    if(!msg || !msg.hdr || 
       typeof msg.hdr.typ !== 'string' ||
       typeof msg.hdr.mid !== 'number' ||
       typeof msg.hdr.src !== 'string' ||
       (!my.running_modules[msg.hdr.src] && 
        msg.hdr.src !== my.core_module.name)) {
      /* We ignore the message. */
      console.log('IGNORED: ' + JSON.stringify(msg));
      return;
    }
    console.log('[(' + msg.hdr.src + ') > (' + (msg.dst || '') + ')]: ' +
                JSON.stringify(msg));


    switch(msg.hdr.typ) {
      /* Modules register to each other events with the `register` message    */
      /* type. It creates a registration for the module issuing this mesage   */
      /* that will get tested against any event emitted. A `registration_id`  */
      /* is created from the `message_id`. Registration `src` and `typ` must  */
      /* string arguments to the RegExp object.                               */
      /* ```                                                                  */
      /* {                                                                    */
      /*   hdr: { typ: 'register', src: 'mod_test', mid: 123, }               */
      /*   src: '.*',                                                         */
      /*   typ: 'state:.*',                                                   */
      /* }                                                                    */
      /* ```                                                                  */
      case 'register': {
        if(typeof msg.src === 'string' && typeof msg.typ === 'string') {
          my.running_modules[msg.hdr.src].registrations.push({
            source: new RegExp(msg.src),
            type: new RegExp(msg.typ),
            registration_id: msg.hdr.mid
          });
          console.log('REGISTER: ' + msg.hdr.src);
          console.log(msg.src);
          console.log(msg.typ);
        }
        break;
      }
      /* Modules delete created registrations with the `unregister` message   */
      /* type.                                                                */
      /* ```                                                                  */
      /* {                                                                    */
      /*   hdr: { typ: 'register', src: 'mod_test', mid: 137, }               */
      /*   rid: 123                                                           */
      /* }                                                                    */
      /* ```                                                                  */
      case 'unregister': {
        if(typeof msg.rid === 'number') {
          var registrations = my.running_modules[msg.hdr.src].registrations;
          for(var i = registrations.length - 1; i >= 0; i --) {
            if(registrations[i].registration_id === msg.rid) {
              registrations.splice(i, 1);
            }
          }
        }
        break;
      }
      /* Events are emitted by modules as messages with the `event` type.     */
      /* They are then tested against each module registrations and           */ 
      /* dispatched accordingly.                                              */
      /* ```                                                                  */
      /* {                                                                    */
      /*   hdr: { typ: 'event', src: 'core', mid: 123, }                      */
      /*   typ: 'state:change',                                               */
      /*   evt: { ... }                                                       */
      /* }                                                                    */
      /* ```                                                                  */
      case 'event': {
        for(var name in my.running_modules) {
          if(my.running_modules.hasOwnProperty(name)) {
            my.running_modules[name].registrations.forEach(function(r) {
              if(r.source.test(msg.hdr.src) &&
                 r.type.test(msg.typ) &&
                 msg.hdr.src !== name) {
                my.running_modules[name].process.send(msg);
              }
            });
          }
        }
        break;
      }
      /* Modules perform remote procedure call by sending messages with the   */
      /* `rpc_call` type. The message is then forwarded to the appropriate    */
      /* module or handled here if it is targeted at the `core` module        */
      /* ```                                                                  */
      /* {                                                                    */
      /*   hdr: { typ: 'rpc_call', src: 'mod_test', mid: 23 },                */
      /*   dst: 'core',                                                       */
      /*   prc: 'new_page',                                                   */
      /*   arg: { ... }                                                       */
      /* }                                                                    */
      /* ```                                                                  */
      case 'rpc_call': {
        /* All modules procedure handling. */
        if(my.running_modules[msg.dst] && 
           (my.running_modules[msg.hdr.src] || 
            msg.hdr.src === my.core_module.name)) {
          my.running_modules[msg.dst].process.send(msg);
        }
        /* Core module procedure handling. */
        else if(msg.dst === my.core_module.name) {
          msg.oid = msg.hdr.mid;
          msg.hdr.mid = ++my.core_module.message_id;
          msg.hdr.typ = 'rpc_reply';
          msg.dst = msg.hdr.src;
          msg.hdr.src = my.core_module.name;
          if(my.core_module.procedures[msg.prc]) {
            my.core_module.procedures[msg.prc](msg.arg, function(err, res) {
              if(err) {
                msg.err = { msg: err.message, nme: err.name };
              }
              else {
                msg.res = res;
              }
              process.nextTick(function() {
                dispatch(msg)
              });
            });
          }
          else {
            msg.err = {
              msg: 'Procedure not found: `' + msg.prc + '`',
              nme: 'procedure_not_found'
            };
            process.nextTick(function() {
              dispatch(msg)
            });
          }
        }
        break;
      }
      /* Modules reply to an `rpc_call` message with a `rpc_reply` message    */
      /* type. The message payload is recycled and a `err` or `res` object is */
      /* added to it along with `oid` field (original message id) equal to    */
      /* the `mesage_id` of the original `rpc_call`.                          */
      /* ```                                                                  */
      /* {                                                                    */
      /*   hdr: { typ: 'rpc_reply', src: 'core', mid: 248 },                  */
      /*   dst: 'mod_test',                                                   */
      /*   prc: 'new_page',                                                   */
      /*   arg: { ... }                                                       */
      /*   oid: 23,                                                           */
      /*   err: { msg: '', nme: '' }                                          */
      /*   res: { ... }                                                       */
      /* }                                                                    */
      /* ```                                                                  */
      case 'rpc_reply': {
        if(my.running_modules[msg.dst] && 
           my.running_modules[msg.dst].process) {
          my.running_modules[msg.dst].process.send(msg);
        }
        /* Core module procedure reply handling. */
        else if(msg.dst === my.core_module.name) {
          var err = null;
          if(msg.err) {
            err = common.err(msg.err.msg, msg.err.name);
          }
          if(my.core_module.rpc_calls[msg.oid]) {
            my.core_moodule.rpc_calls[msg.oid](err, msg.res);
            delete my.core_module.rpc_calls[msg.oid];
          }
        }
        break;
      }
    }
  };


  /****************************************************************************/
  /* PUBLIC CORE MODULE METHODS */
  /****************************************************************************/
  // ### core_expose
  //
  // Exposes a procedure on behalf of the core module
  // ```
  // @proc {string} procedure name
  // @fun  {function(args, cb_)} the actual procedure
  // ```
  core_expose = function(proc, fun) {
    my.core_module.procedures[proc] = fun;
  };

  // ### core_call
  //
  // Exposes a way for the core module to call rpc methods on modules
  // ```
  // @name {string} the module name
  // @proc {string} the procedure name
  // @args {object} serializable JSON arguments
  // @cb_  {function(err, res)} the callback when the rpc completes
  // ```
  core_call = function(name, proc, args, cb_) {
    //console.log('`core_call`: ' + name + ' ' + JSON.stringify(args));
    dispatch({
      hdr: { 
        typ: 'rpc_call', 
        src: my.core_module.name, 
        mid: ++my.core_module.message_id 
      },
      dst: name,
      prc: proc,
      args: args
    });
    my.core_module.rpc_calls[my.core_module.message_id] = cb_;
  };

  // ### core_emit
  //
  // Emits an event on behalf of the core module
  // ```
  // @type  {string} event type
  // @event {object} serializable object
  // ```
  core_emit = function(type, event) {
    //console.log('`core_emit`: ' + type + ' ' + JSON.stringify(event));
    dispatch({
      hdr: { 
        typ: 'event', 
        src: my.core_module.name, 
        mid: ++my.core_module.message_id 
      },
      typ: type,
      evt: event
    });
  };


  /****************************************************************************/
  /* PUBLIC MODULE ACTIONS */
  /****************************************************************************/
  // ### add
  //
  // Adds a module to the module database for this session. Next time the module
  // is run, an attempt to install it will be made. If a module with the same
  // base path (ignoring tags) exists, an error is raised.
  // ```
  // @path {string} the module path
  // @cb_  {function(err, module)}
  // ```
  add = function(path, cb_) {
    augment_path(path, function(err, path) {
      if(err) {
        return cb_(err);
      }
      var module = {};
      var package_json = null;
      var version = null;

      async.series([
        /* Check that the module is not already present. */
        function(cb_) {
          my.db.find({}, function(err, modules) {
            if(err) {
              return cb_(err);
            }
            for(var i = 0; i < modules.length; i ++) {
              var m = modules[i];
              if(expand_path(m.path).type === expand_path(path).type) {
                if(m.path === path ||
                   (expand_path(path).type === 'github' &&
                    expand_path(m.path).owner === expand_path(path).owner && 
                    expand_path(m.path).name === expand_path(path).name) ||
                   (expand_path(path).type === 'local' &&
                    m.path === path)) {
                  return cb_(common.err('Module conflict: ' + 
                                        path + ' conflicts with ' + m.path,
                                        'module_manager:module_conflict'));
                }
              }
            }
            return cb_();
          });
        },
        /* Retrieves the module package.json. */
        function(cb_) {
          if(expand_path(path).type === 'local') {
            var package_path = require('path').join(expand_path(path).path, 
                                                    'package.json');

            fs.readFile(package_path, function(err, data) {
              if(err) {
                return cb_(err);
              }
              try {
                package_json = JSON.parse(data);
              }
              catch(err) {
                return cb_(err);
              }
              return cb_();
            });
          }
          if(expand_path(path).type === 'github') {
            /* Works with tags AND master */
            var package_url = 'https://raw.github.com/' + 
              expand_path(path).owner + '/' + 
              epxand_path(path).name + '/' + 
              expand_path(path).tag + '/package.json';

            https.get(package_url, function(res) {
              res.setEncoding('utf8');
              var data = '';
              res.on('data', function(chunk) {
                data += chunk;
              });
              res.on('end', function() {
                try {
                  package_json = JSON.parse(data);
                }
                catch(err) {
                  return cb_(err);
                }
                return cb_();
              });
            }).on('error', cb_);
          }
        },
        /* Checks the package.json, retrieve the version, add module. */
        function(cb_) {
          module.active = true;
          module.path = path;
          module.version = semver.clean(package_json.version, true);
          if(!module.version) {
            return cb_(common.err('Invalid module version `' + module.version + 
                                  '` for module: ' + path,
                                  'module_manager:invalid_version'));
          }
          module.name = package_json.name;
          if(!module.name) {
            return cb_(common.err('Invalid module name `' + module.name + 
                                  '` for module: ' + path,
                                  'module_manager:invalid_name'));
          }

          my.db.find({ name: module.name }, function(err, modules) {
            if(err) {
              return cb_(err);
            }
            if(modules.length > 0) {
              return cb_(common.err('Module conflict: ' + 
                                    module.name + ' conflicts with ' + m.name,
                                    'module_manager:module_conflict'));
            }
            return cb_();
          });
        },
        /* Finally adds the module. */
        function(cb_) {
          my.db.update({ 
            path: module.path
          }, module, {
            upsert: true
          }, cb_);
        },
      ], function(err) {
        return cb_(err, module);
      });
    });
  };

  // ### list
  //
  // Lists the modules managed by the module manager for this session and their
  // current status.
  // ```
  // @cb_  {function(err, modules)}
  // ```
  list = function(cb_) {
    my.db.find({}, function(err, modules) {
      if(err) {
        return cb_(err);
      }
      return cb_(null, modules.map(function(m) {
        delete m._id;
        if(my.running_modules[m.name]) {
          m.running = true;
        }
        return m;
      }));
    });
  };

  // ### install
  //
  // Installs a module locally. This function is indempotent and can be called
  // on any module any number of time to verify the module is correclty
  // installed.
  // If the module is not present locally, it will be downloaded and installed.
  // The module path should have been added already as well as the module info
  // is retrieved from the module database by path.
  // ```
  // @path {string} the module path
  // @cb_  {function(err, module)}
  // ```
  install = function(path, cb_) {
    var module = null;

    async.series([
      /* Check that the module exists. */
      function(cb_) {
        my.db.find({ path: path }, function(err, modules) {
          if(err) {
            return cb_(err);
          }
          if(modules.length === 0) {
            return cb_(common.err('Module unknown: ' + path,
                                  'module_manager:module_unknown'));
          }
          else {
            module = modules[0];
            return cb_();
          }
        });
      },
      /* Installs the module locally. */
      function(cb_) {
        fs.stat(storage_path(path), function(err, stat) {
          if(err && err.code !== 'ENOENT') {
            return cb_(err);
          }
          else if(err && err.code === 'ENOENT') {
            if(expand_path(path).type === 'github') {
              var options = {
                url: 'https://api.github.com' + 
                     '/repos/' + module.owner + '/' + module.name + 
                     '/tarball/' + module.tag,
                headers: {
                  'User-Agent': 'Mozilla/5.0'
                }
              }
              var gzip = zlib.createGunzip();
              var tar = require('tar').Extract({ 
                path: storage_path(path),
                strip: 1
              });
              request(options).pipe(gzip).pipe(tar)
              .on('end', cb_)
              .on('error', function(err) {
                fs.remove(storage_path(path))
                return cb_(err);
              });
            }
            if(expand_path(path).type === 'local') {
              return cb_(err);
            }
          }
          else {
            return cb_();
          }
        });
      },
      /* Run npm install on the local module. */
      function(cb_) {
        npm.commands.install(storage_path(path), [], function(err, data) {
          if(err) {
            return cb_(err);
          }
          /* TODO(spolu): handle data. */
          return cb_();
        });
      }
    ], cb_);
  };

  // ### remove
  //
  // Remove the module from the module database and delete it from filesystem.
  // ```
  // @path {string} the module path
  // @cb_  {function(err, module)}
  // ```
  remove = function(path, cb_) {
    var module = null;
    async.series([
      /* Check that the module exists. */
      function(cb_) {
        my.db.find({ path: path }, function(err, modules) {
          if(err) {
            return cb_(err);
          }
          if(modules.length === 0) {
            return cb_(common.err('Module unknown: ' + path,
                                  'module_manager:module_unknown'));
          }
          else {
            module = modules[0];
            return cb_();
          }
        });
      },
      /* Remove the module from the module db. */
      function(cb_) {
        my.db.remove({ 
          path: path,
        }, {
          multi: true
        }, cb_);
      },
      /* Remove the module from filesystem if not local. */
      function(cb_) {
        if(expand_path(path).type === 'github') {
          fs.remove(storage_path(path), cb_)
        }
        if(expand_path(path).type === 'local') {
          return cb_();
        }
      },
      /* Finally stop the module. */
      function(cb_) {
        if(my.running_modules[module.name]) {
          kill_module(module.name, cb_);
        }
        else {
          return cb_();
        }
      }
    ], cb_);
  };


  /****************************************************************************/
  /* PUBLIC RUN/KILL MODULE */
  /****************************************************************************/
  // ### run_module
  //
  // Attemps to locally install the module and run it. It sets up all the hooks
  // required by a running module and calls the exposed `init` method on the
  // newly created process.
  // ```
  // @path {string} the module path
  // @cb_    {function(err)}
  // ```
  run_module = function(path, cb_) {
    var module = null;
    async.series([
      /* Check that the module exists. */
      function(cb_) {
        my.db.find({ path: path }, function(err, modules) {
          if(err) {
            return cb_(err);
          }
          if(modules.length === 0) {
            return cb_(common.err('Module unknown: ' + path,
                                  'module_manager:module_unknown'));
          }
          else {
            module = modules[0];
            return cb_();
          }
        });
      },
      /* Install the module (indempotent). */
      function(cb_) {
        install(path, cb_);
      },
      /* Finally run the module. */
      function(cb_) {
        common.log.out('`run_module`: ' + module.name + ' [' + path + ']');
        my.running_modules[module.name] = my.running_modules[module.name] || {
          process: null,
          name: module.name,
          path: path,
          restart: 0,
          registrations: []
        };

        var p = child_process.fork(storage_path(path), ['--no-chrome']);
        my.running_modules[module.name].process = p;

        p.on('exit', function(code) {
          /* For now all modules are supposed to be longlived. So any module */
          /* exiting is treated as an error and the module is restarted.     */
          common.log.out('Module exited unexpectedly: ' + path);
          p.removeAllListeners();
          delete my.running_modules[module.name].process;

          if(my.running_modules[module.name].restart < 3) {
            common.log.out('Restarting: ' + module.name);
            my.running_modules[module.name].restart++;
            run_module(path, function() {});
          }
          else {
            /* After 3 restarts we stop restarting the module. */
            delete my.running_modules[module.name];
          }
        });

        p.on('message', function(msg) {
          if(msg && msg.hdr && 
             msg.hdr.typ === 'event' &&
             msg.typ === 'internal:ready') {
            dispatch({
              hdr: { 
                typ: 'rpc_call', 
                src: my.core_module.name, 
                mid: ++my.core_module.message_id 
              },
              dst: module.name,
              prc: 'init'
            });
          }
          else if(msg && msg.hdr && 
                  typeof msg.hdr.typ === 'string' &&
                  typeof msg.hdr.mid === 'number') {
            msg.hdr.src = module.name;
            dispatch(msg);
          }
          /* Otherwise we ignore the message. */
        });

        return cb_();
      }
    ], cb_);
  };

  // ### kill_module
  //
  // Stops a module by calling its `kill` method (with timeout) and finally
  // shutting down its process.
  // ```
  // @path {string} the module path
  // @cb_    {function(err)}
  // ```
  kill_module = function(path, cb_) {
    var module = null;
    async.series([
      /* Check that the module exists. */
      function(cb_) {
        my.db.find({ path: path }, function(err, modules) {
          if(err) {
            return cb_(err);
          }
          if(modules.length === 0) {
            return cb_(common.err('Module unknown: ' + path,
                                  'module_manager:module_unknown'));
          }
          else {
            module = modules[0];
            return cb_();
          }
        });
      },
      /* Kill. */
      function(cb_) {
        common.log.out('`kill_module`: ' + module.name);
        if(my.running_modules[module.name]) {
          dispatch({
            hdr: { 
              typ: 'rpc_call', 
              src: my.core_module.name, 
              mid: ++my.core_module.message_id 
            },
            dst: module.name,
            prc: 'kill'
          });

          my.shutdown_modules[module.name] = my.running_modules[module.name];
          delete my.running_modules[module.name];

          /* We replace the `exit` listener so that the module does not get */
          /* restarted automatically once it exits.                         */
          my.shutdown_modules[module.name].process.removeAllListeners('exit');
          my.shutdown_modules[module.name].process.on('exit', function() {
            common.log.out('Module exited after `kill_module`: ' + module.name);
            my.shutdown_modules[module.name].process.removeAllListeners();
            delete my.shutdown_modules[module.name];
            return cb_();
          });

          /* A timeout is setup to kill the module if it failed to exit on its */
          /* own in the next 5s.                                               */
          setTimeout(function() {
            if(my.shutdown_modules[module.name]) {
              common.log.out('Module forced kill: ' + module.name);
              my.shutdown_modules[module.name].process.kill();
            }
          }, 5 * 1000);
        }
        else {
          return cb_();
        }
      }
    ], cb_);
  };


  /****************************************************************************/
  /* INIT / KILL */
  /****************************************************************************/
  // ### init
  //
  // Inits the module manager. Modules are not started, and should be started by
  // the session.
  // ```
  // @cb_ {function(err)} asynchronous callback
  // ```
  init = function(cb_) {
    var missing = [];
    var ready = [];
    var failed = [];
    
    async.series([
      /* Initialization. */
      function(cb_) {
        mkdirp(my.modules_path, function(err) {
          if(err) { 
            return cb_(err);
          }
          my.db = new nedb({ 
            filename: my.session_data_path, 
            autoload: true 
          });
          var now = Date.now();
          return npm.load({
            cache: require('path').join(my.modules_path, 'extract', 'npm_cache')
          }, cb_);
        });
      }
    ], function(err) {
      /* TODO(spolu): spawn a check for updates. This should happen in the */
      /*              background and in series.                            */
      return cb_(err);
    });
  };

  // ### kill
  //
  // Kills the modules manager. It calls the kill procedure on each modules with
  // a timeout before shutting down the module. Once all modules are shutdown it
  // returns the callback.
  // ```
  // @cb_ {function(err)}
  // ```
  kill = function(cb_) {
    var arr = [];
    for(var name in my.running_modules) {
      if(my.running_modules.hasOwnProperty(name)) {
        arr.push(my.running_modules[name]);
      }
    }
    async.each(arr, function(module, cb_) {
      kill_module(module.name, cb_);
    }, function(err) {
      if(err) {
        return cb_(err);
      }
      common.log.out('All modules stopped.');
      return cb_();
    });
  };

  common.method(that, 'core_expose', core_expose, _super);
  common.method(that, 'core_call', core_call, _super);
  common.method(that, 'core_emit', core_emit, _super);

  common.method(that, 'add', add, _super);
  common.method(that, 'list', list, _super); 
  common.method(that, 'install', install, _super);
  common.method(that, 'remove', remove, _super);

  common.method(that, 'run_module', run_module, _super);
  common.method(that, 'kill_module', kill_module, _super);

  //common.method(that, 'update', update, _super);
  //common.method(that, 'info', info, _super);
  

  common.method(that, 'init', init, _super);
  common.method(that, 'kill', kill, _super);

  return that;
};

exports.module_manager = module_manager;
