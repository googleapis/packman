/**
 * Copyright 2016 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

var _ = require('lodash');
var async = require('async');
var child_process = require('child_process');
var config = require('./config');
var fs = require('fs-extra');
var glob = require('glob');
var packager = require('./packager');
var path = require('path');
var pbjs = require('protobufjs/cli/pbjs');
var pbjs_util = require('protobufjs/cli/pbjs/util');
var request = require('request');
var tmp = require('tmp');

var EventEmitter = require('events').EventEmitter;
var ProtoBuf = require('protobufjs');
var StreamZip = require('node-stream-zip');

exports.ApiRepo = ApiRepo;
exports.GOOGLE_APIS_REPO_ZIP = GOOGLE_APIS_REPO_ZIP;

var GOOGLE_APIS_REPO_ZIP =
    'https://github.com/googleapis/googleapis/archive/master.zip';

var DEFAULT_LANGUAGES = [
  'go',
  'objc',
  'nodejs',
  'python',
  'ruby',
  'php'
];

// nodejs builds using ProtoBuf.js, and the Java package just copies protos.
var NO_PROTOC_PLUGIN = ['nodejs', 'java'];

// the default include path, where install the protobuf runtime installs its
// protos.
var DEFAULT_INCLUDE_PATH = Object.freeze(['/usr/local/include']);

/**
 * ApiRepo represents a published repo containing API protos.
 */
function ApiRepo(opts) {
  opts = opts || {};
  this.depBins = {};
  this.opts = opts;
  this.packageInfo = config.packageInfo(opts);
  this.commonPb = config.commonPb(opts);
  this.includePath = opts.includePath || DEFAULT_INCLUDE_PATH;
  this.languages = opts.languages || DEFAULT_LANGUAGES;
  this.outDir = opts.outDir || tmp.dirSync().name;
  this.gaxDir = opts.gaxDir;
  this.repoDir = opts.repoDir;
  this.templateRoot = opts.templateRoot;
  this.pkgPrefix = opts.pkgPrefix;
  this.overridePlugins = opts.overridePlugins;
  this.zipUrl = opts.zipUrl;
  this.isGoogleApi = !!opts.isGoogleApi;
  if (!(this.repoDir || this.zipUrl)) {
    this.zipUrl = GOOGLE_APIS_REPO_ZIP; // default to download googleapis
    this.isGoogleApi = true;
  }
}
ApiRepo.prototype =
    Object.create(EventEmitter.prototype, { constructor: { value: ApiRepo } });

/**
 * setUp prepares an ApiRepo for use.
 *
 * After it is called, build packages in the repo's 'ready' event.
 * It ensures that
 * - the binaries needed to complete code generation are already available
 * - the configured api repository is valid and available.
 *
 * repo = new ApiRepo({
 *   isGoogleApi: true,
 *   languages: ['python', 'ruby']
 * });
 *
 * repo.on('ready', function() {
 *   repo.buildPackages(name, version);  // build the given api
 * });
 *
 * OR
 *
 * repo.on('ready', function() {
 *   repo.buildCommonProtoPkgs();  // build the common protos
 * });
 *
 * then
 *
 * repo.on('err', function(err) {
 *   console.error('Could not build packages:', err);
 * });
 * repo.setUp();
 */
ApiRepo.prototype.setUp = function setUp() {

  // checkDeps wraps this._checkDeps to include in the setUp async waterfall.
  var checkDeps = function checkDeps(next) {
    this._checkDeps(null /* use instance opts */, next);
  }.bind(this);

  // done is run when setUp completes.
  var done = function done(err) {
    if (!err) {
      this.emit('ready');
    } else {
      this.emit('error', err);
    }
  }.bind(this);
  async.waterfall([
    this._checkRepo.bind(this),
    checkDeps
  ], done);
};

var defaultTemplateInfo = {
  go: {
    templateDir: 'go'
  },
  objc: {
    templateDir: 'objc'
  },
  nodejs: {
    templateDir: 'nodejs'
  },
  python: {
    templateDir: 'python'
  },
  ruby: {
    templateDir: 'ruby'
  },
  java: {
    templateDir: 'java'
  },
  php: {
    templateDir: 'php'
  }
};

/**
 * Update the templateDir in each info in templateInfo by prefixing it with
 * root.
 */
var rootTemplateDir = function rootTemplateDir(templateInfo, root) {
  var res = _.cloneDeep(templateInfo);
  _.forEach(res, function(info) {
    info.templateDir = path.join(root, info.templateDir);
  });
  return res;
};

/**
 * buildPackages builds the configured languages packages.
 *
 * It is to be called once the repo is 'ready' after setUp is called.
 *
 * repo = new ApiRepo({
 *   isGoogleApi: true,
 *   languages: ['python', 'ruby']
 * });
 * repo.on('ready', function() {
 *   repo.buildPackages(name, version);  // called then the repo is ready
 * });
 * repo.on('err', function(err) {
 *   console.error('Could not build packages:', err);
 * });
 * repo.setUp();
 */
ApiRepo.prototype.buildPackages =
    function buildPackages(name, version, opt_done) {
      var tasks = [];
      var that = this;
      var done = this._wrap_done(opt_done);
      var altJava = this.opts.altJava;

      var templateInfo = rootTemplateDir(defaultTemplateInfo, this.templateRoot);
      this.languages.forEach(function(l) {
        var makePackageTasks = [that._buildProtos.bind(that, name, version, l)];
        if (packager[l]) {
          var buildAPackage = function buildAPackage(generated, next) {
            var opts = _.merge({
              'altJava': altJava,
              'top': path.join(that.outDir, l),
              'packageInfo': that.packageInfo,
              'generated': generated
            }, templateInfo[l]);
            if (l == 'nodejs' && !that.opts.nodejsUsePbjs) {
              opts.packageInfo.protoFiles = _.filter(generated, function(file) {
                return file.match(/\.proto$/);
              });
              opts.packageInfo.nodejsUseProtos = true;
            }
            var cleanName = name.replace('/', '-');
            opts.packageInfo.api.simplename = cleanName;
            opts.packageInfo.api.path = cleanName.replace('-', '/');
            opts.packageInfo.api.name = that.pkgPrefix + cleanName;
            opts.packageInfo.api.version = version;
            var semver = opts.packageInfo.api.semver[l];
            if (semver) {
              opts.packageInfo.api.semantic_version = semver;
            }
            packager[l](opts, next);
          };
          makePackageTasks.push(buildAPackage);
        }
        tasks.push(async.waterfall.bind(null, makePackageTasks));
      });
      async.parallel(tasks, done);
    };


/**
 * buildGaxPackages builds the gax packages for the configued languages.
 *
 * It is to be called once the repo is 'ready' after setUp is called.
 *
 * repo = new ApiRepo({
 *   isGoogleApi: true,
 *   languages: ['python', 'ruby']
 * });
 * repo.on('ready', function() {
 *   repo.buildGaxPackages(name, version);  // called then the repo is ready
 * });
 * repo.on('err', function(err) {
 *   console.error('Could not build gax packages:', err);
 * });
 * repo.setUp();
 */
ApiRepo.prototype.buildGaxPackages =
    function buildGaxPackages(name, version, opt_done) {
      var tasks = [];
      var that = this;
      var done = this._wrap_done(opt_done);

      var templateRoot = path.join(__dirname, '..', 'templates', 'gax');
      var templateInfo = rootTemplateDir(defaultTemplateInfo, templateRoot);
      var numLanguages = this.languages.length;
      this.languages.forEach(function(l) {
        if (packager[l]) {
          var buildAPackage = function buildAPackage(next) {
            var top = path.join(that.outDir, l);
            if (numLanguages == 1) {
              top = that.outDir;
            }
            var opts = _.merge({
              'top': top,
              'packageInfo': that.packageInfo
            }, templateInfo[l]);
            var cleanName = name.replace('/', '-');
            var pkgName = that.pkgPrefix + cleanName;
            var shortName = name.split('/').slice(-1)[0];
            var titleName = shortName[0].toUpperCase() + shortName.slice(1);
            opts.packageInfo.api.simplename = cleanName;
            opts.packageInfo.api.path = cleanName.replace('-', '/');
            opts.packageInfo.api.name = pkgName;
            opts.packageInfo.api.dependsOn = pkgName.replace('gax', 'grpc');
            opts.packageInfo.api.titlename = titleName;
            opts.packageInfo.api.shortname = shortName;
            opts.packageInfo.api.version = version;
            var semver = opts.packageInfo.api.semver[l];
            if (semver) {
              opts.packageInfo.api.semantic_version = semver;
            }
            packager[l](opts, next);
          };
          tasks.push(buildAPackage);
        }
      });
      async.parallel(tasks, done);
    };


var commonPbTemplateInfo = {
  go: {
    templateDir: 'go'
  },
  objc: {
    templateDir: 'objc'
  },
  nodejs: {
    templateDir: 'nodejs'
  },
  python: {
    copyables: [
      'README.rst'
    ],
    templateDir: 'python'
  },
  ruby: {
    templateDir: 'ruby'
  },
  java: {
    templateDir: 'java'
  },
  php: {
    templateDir: 'php'
  }
};

/**
 * _wrap_done wraps the optional 'done' callback used in the buildXXX methods,
 * ensuring that errors trigger the error event.
 */
ApiRepo.prototype._wrap_done = function _wrap_done(opt_done) {
  return function done(err) {
    if (err) {
      this.emit('error', err);
    }
    if (opt_done) {
      opt_done(err);
    }
  }.bind(this);
};

/**
 * buildCommonProtoPkgs builds the core proto packages in the configured
 *   languages
 *
 * It is to be called once the repo is 'ready' after setUp is called.
 *
 * repo = new ApiRepo({
 *   languages: ['python', 'ruby']
 * });
 * repo.on('ready', function() {
 *   repo.buildCommonProtoPkgs(name, version);  // repo is ready
 * });
 * repo.on('err', function(err) {
 *   console.error('Could not build packages:', err);
 * });
 * repo.setUp();
 */
ApiRepo.prototype.buildCommonProtoPkgs =
    function buildCommonProtoPkgs(opt_done) {
      var tasks = [];
      var that = this;
      var altJava = this.opts.altJava;
      var done = this._wrap_done(opt_done);

      var templateRoot = path.join(__dirname, '..', 'templates', 'commonpb');
      var templateInfo = rootTemplateDir(commonPbTemplateInfo, templateRoot);
      this.languages.forEach(function(l) {
        var buildProtoTasks = [];
        that.commonPb.packages.forEach(function(pkgSpec) {
          buildProtoTasks.push(
              that._buildProtos.bind(
                  that,
                  pkgSpec.name,
                  pkgSpec.version,
                  l)
              );
        });
        var makePackageTasks = [async.series.bind(async, buildProtoTasks)];
        if (packager[l]) {
          var buildAPackage = function buildAPackage(allGenerated, done) {
            var opts = _.merge({
              'altJava': altJava,
              'buildCommonProtos': true,
              'top': path.join(that.outDir, l),
              'packageInfo': that.packageInfo,
              'generated': _.union(_.flatten(allGenerated))
            }, templateInfo[l]);
            opts.packageInfo.api.name = that.pkgPrefix;
            opts.packageInfo.api.semantic_version = that.commonPb.semver;
            packager[l](opts, done);
          };
          makePackageTasks.push(buildAPackage);
        }
        tasks.push(async.waterfall.bind(null, makePackageTasks));
      });
      async.parallel(tasks, done);
    };

/**
 * Collect the required files from a .proto file. 'done' will be
 * called with the list of file name within the includePath when
 * the task has finished.
 */
function collectProtoDeps(protoFile, includePath, done) {
  var deps = tmp.fileSync();
  var desc = tmp.fileSync();
  var args = ['--dependency_out=' + deps.name, '-o', desc.name];
  if (includePath) {
    includePath.forEach(function(ipath) {
      args.push('-I', ipath);
    });
  }
  args.push(protoFile);
  // Invokes protoc with --dependency_out to generate the dependency
  // proto files.
  child_process.execFile('protoc', args, {}, function(err) {
    if (err) {
      done(err);
    }
    fs.readFile(deps.name, 'utf-8', function(err, data) {
      if (err) {
        done(err);
      }
      // protoc generates the dependencies 'in the format expected by make',
      // that is -- separated by spaces, and newline character is escaped by
      // a backslash.
      done(null, data.replace(/^\s+/, '').replace(/\\\n/mg, ' ').split(/\s+/m));
    });
  });
}

/**
 * _buildProtos builds the protos for named api and version in the target languages.
 *
 * @param {string} name the api name
 * @param {string} version the api version
 * @param {string} language language to generate protos in
 * @param {function} done the function to run on protoc completion
 */
ApiRepo.prototype._buildProtos =
    function _buildProtos(name, version, language, done) {
      var that = this;
      var topDir = this.outDir;
      var langTopDir = path.join(this.outDir, language);

      /** findOutputs lists the files in the output directory */
      function findOutputs(err) {
        if (err) {
          console.error('findOutputs:start:err', err);
          done(err);
        } else {
          var stripRoot = processPaths(done, function(paths) {
            return _.map(paths, function(x) { return x.replace(langTopDir, ''); });
          });
          glob.glob("**", {
            cwd: langTopDir,
            nodir: true,
          }, stripRoot);
        }
      }
      if (language === 'java') {
        var baseDir = this.opts.altJava ? 'proto' : 'resources';

        var dstResourceDir = path.join(langTopDir, 'src', 'main', baseDir);
        fs.mkdirsSync(dstResourceDir);
        /**
         * copyJavaPb copies a protocol buffer file to the java package resource
         * folder.
         */
        var copyJavaPb = function copyJavaPb(protoPath, next) {
          var src = path.join(this.repoDir, protoPath),
          dst = path.join(dstResourceDir, protoPath);
          fs.copy(src, dst, next);
        }.bind(this);
        this._findProtos(name, version, findOutputs, copyJavaPb);
      } else if (language === 'nodejs') {
        /**
         * makeProtoBasedNodeModule finds the required .proto files for the API
         * and copies them into the output directory.
         */
        var makeProtoBasedNodeModule =
            function makeProtoBasedNodeModule(fullPathProtos, includePath) {
          // filesMap keeps the mapping for proto files from the source file
          // locaiton to the destination.
          var filesMap = {};
          var outDir = path.join(langTopDir, 'proto');

          /** Add an entry for filePath to filesMap. */
          function addToFilesMap(filePath) {
            if (filePath in filesMap) {
              return;
            }
            for (var i = 0; i < includePath.length; ++i) {
              if (filePath.indexOf(includePath[i]) === 0) {
                var relativePath = filePath.slice(includePath[i].length + 1);
                filesMap[filePath] = path.join(outDir, relativePath);
                return;
              }
            }
          }

          var tasks = _.map(fullPathProtos, function(proto) {
            return function collectProtoTask(next) {
              collectProtoDeps(proto, includePath, function(err, deps) {
                if (err) {
                  next(err);
                  return;
                }
                // Building filesMap contents for the dependencies.
                deps.forEach(addToFilesMap);
                next();
              });
            };
          });
          async.waterfall(tasks, function(err) {
            async.forEachOf(filesMap, function(dst, src, next) {
              fs.mkdirsSync(path.dirname(dst));
              fs.copy(src, dst, next);
            }, findOutputs);
          });
        };
        /**
         * makeNodeModule writes a commonJS module containing all the protos
         * used by service.
         */
        var makeNodeModule = function makeNodeModule(err, allProtos) {
          if (err !== null) {
            findOutputs(err);
            return;
          }
          var fullPathProtos = _.map(allProtos, function(x) {
            return path.join(this.repoDir, x);
          }.bind(this));

          var includePath = _.union(this.includePath, [this.repoDir]);
          if (!this.opts.nodejsUsePbjs) {
            makeProtoBasedNodeModule(fullPathProtos, includePath);
            return;
          }
          var opts = {
            root: that.repoDir,
            source: 'proto',
            path: includePath
          };

          var builder = loadProtos(fullPathProtos, opts);
          var outDir = path.join(this.outDir, language);
          fs.mkdirsSync(outDir);
          var servicePath = path.join(outDir, 'service.js');
          var commonJS = pbjs.targets.commonjs(builder, opts);
          fs.writeFile(servicePath, commonJS, findOutputs);
        }.bind(this);
        this._findProtos(name, version, makeNodeModule);
      } else {
        var protoc = this._makeProtocFunc(this.opts, language);
        this._findProtos(name, version, findOutputs, protoc);
      }
    };

/**
 * Defines the default plugin name. Only languages where the default plugin
 * name does not follow the format grpc_<lang>_plugin need to be specified.
 */
var defaultPluginName = {
  go: 'protoc-gen-go',
  php: 'protoc-gen-php'
};

ApiRepo.prototype._getPluginName = function _getPluginName(lang, overridePlugins) {
  if (_.has(overridePlugins, lang)) {
    return overridePlugins[lang];
  } else if (_.has(defaultPluginName, lang)) {
    return defaultPluginName[lang];
  } else {
    return 'grpc_' + lang + '_plugin';
  }
};

/**
 * _checkDeps confirms that the tools needed to generate the required protos
 * are present.
 */
ApiRepo.prototype._checkDeps = function _checkDeps(opts, done) {
  // If nodejs is the only language, there are no dependencies.
  if (this.languages.length === 1 && this.languages.indexOf('nodejs') !== -1) {
    done(null);
    return;
  }

  // If gaxDir is set, are no dependencies, as protoc is not run
  if (this.gaxDir) {
    done(null);
    return;
  }

  opts = opts || {};
  opts.env = opts.env || this.opts.env || process.env;
  var reqdBins = ['protoc'];
  var that = this;
  this.languages.forEach(function(l) {
    if (_.includes(NO_PROTOC_PLUGIN, l)) {
      return;
    }
    reqdBins.push(that._getPluginName(l, that.overridePlugins));
  });

  function isInPath(err, data) {
    if (!err) {
      var binPaths = data.split("\n");
      _.forEach(reqdBins, function(b) {
        _.forEach(binPaths, function(p) {
          if (_.endsWith(p, b)) {
            that.depBins[b] = p;
          }
        });
      });

      console.log(that.depBins);
    }
    done(err, data);
  }
  child_process.execFile('which', reqdBins, {env: opts.env}, isInPath);
};

/**
 * newIsDirFunc creates a function isDir(callback) that asynchronouosly
 * confirms if dirName is a directory.
 *
 * @param dirName the directory to check.
 * @return function isDir(callback)
 */
function newIsDirFunc(dirName) {
  return function(done) {
    function statCb(err, stats) {
      if (err) {
        console.error('directory not found: ', dirName);
        return done(err);
      }
      if (!stats.isDirectory()) {
        console.error('file was not a directory: ', dirName);
        return done(new Error('not a directory'));
      }
      return done(null);
    }
    fs.stat(dirName, statCb);
  };
}

/**
 * _verifyRepo confirms that api repo source is available.
 *
 * if repoDir is set, it confirms that the directory exists
 *
 * if repoDir is not set, but zipUri is, it downloads the api zip to tmp dir and
 * sets that to repoDir
 *
 * if isGoogleApi is `true`, it confirms that repoDir has 'google' subdirectory
 */
ApiRepo.prototype._checkRepo = function _checkRepo(done) {
  var that = this;
  if (this.repoDir) {
    var checkDir = newIsDirFunc(this.repoDir);
    if (this.isGoogleApi) {
      var checkGoogleDir = newIsDirFunc(path.join(that.repoDir, 'google'));
      async.waterfall([checkDir, checkGoogleDir], done);
    } else {
      checkDir(done);
    }
    return;
  }
  function makeTmpDir(next) {
    tmp.dir({}, next);
  }
  function makeTmpZip(dirName, _unused, next) {
    var fileCb = function fileCb(err, tmpPath, fd) {
      next(err, dirName, tmpPath, fd);
    };
    tmp.file({
      mode: 420 /* 0644 */,
      prefix: 'repo-',
      postfix: '.zip' }, fileCb);
  }
  function saveZip(dirname, tmpPath, fd, next) {
    console.log("writing", that.zipUrl, "to fd:", fd);
    var stm = request(that.zipUrl).pipe(fs.createWriteStream('', {fd: fd}));
    stm.on('close', function() {
      console.log('saved zip to ', tmpPath);
      next(null, dirname, tmpPath);
    });
  }
  function extractZip(dirname, tmpPath, next) {
    var zip = new StreamZip({
      file: tmpPath,
      storeEntries: true
    });
    zip.on('error', function(err) { next(err); });
    zip.on('ready', function() {
      zip.extract(null, dirname, function(err, count) {
        if (err) {
          console.error('extract failed:', err);
          return next(err);
        }
        return next(null, dirname);
      });
    });
  }
  function updateRepoDir(dirName, next) {
    fs.readdir(dirName, function(err, files) {
      if (err) {
        return next(err);
      }
      if (files.length > 1) {
        console.error('Malformed zip had', files.length, 'top-level dirs');
        return next(new Error('Malformed zip: more than 1 top-level dir'));
      }
      that.repoDir = path.join(dirName, files[0]);
      console.log('repoDir is ', that.repoDir);
      return next(null);
    });
  }
  function checkNewSubDir(callback) {
    var checkGoogleDir = newIsDirFunc(path.join(that.repoDir, 'google'));
    checkGoogleDir(callback);
  }
  if (this.zipUrl) {
    var tasks = [
      makeTmpDir,   // make a tmp directory
      makeTmpZip,   // make a tmp file in which to save the zip
      saveZip,      // pull the zip archive and save it
      extractZip,   // extract the zip and save in the tmp directory
      updateRepoDir // set the top-level dir of the extracted zip as repoDir
    ];
    if (this.isGoogleApi) {
      tasks.push(checkNewSubDir);  // check that the google dir is present.
    }
    async.waterfall(tasks, done);
  }
};

var isProtoPath = /.proto$/;

function processPaths(done, process) {
   return function(err, outputs) {
     if (err) {
       done(err);
     } else {
        done(null, process(outputs));
     }
   };
}

/**
 * Finds the paths to the proto files with the given api name and version.
 *
 * If callback is set, it calls back on each of them.
 * @param {string} name the api name.
 * @param {string} version the api version
 * @param {function} done the cb called with all the protos or an error
 * @param {function} onProto the callback called on each proto
 */
ApiRepo.prototype._findProtos = function _findProtos(name, version, done,
                                                     onProto) {
  // Determine the top-level proto dir
  var topDir = this.repoDir;
  var parts = [topDir];
  if (this.isGoogleApi) {
    parts.push('google');
  }
  parts.push(name, version);
  var protoDir = path.join.apply(path, parts);

  /* Use glob to scan for protos in a protoDir */
  function scanForProtos(next) {
    var stripRoot = processPaths(next, function(paths) {
      return _.map(paths, function(x) { return x.replace(topDir + '/', ''); });
    });

    glob.glob("*.proto", {
      cwd: protoDir,
      realpath: true,
      nodir: true,
    }, stripRoot);
  }

  /* Optionally process each proto */
  function actOnProtos(foundProtos, next) {
    if (onProto) {
      async.map(foundProtos, onProto, function(err) {
        if (err) {
          next(err);
        } else {
          next(null, foundProtos);
        }
      });
    } else {
      next(null, foundProtos);
    }
  }
  async.waterfall([
    newIsDirFunc(protoDir),  /* verify the proto dir exists */
    scanForProtos,           /* scan for proto files in it */
    actOnProtos              /* optionally process each proto in it */
  ], done);
};

/**
 * _makeProtocFunc makes a function that calls the protoc command line on
 * a proto in a given languages.
 *
 * @param {object} opts configure the call
 * @param {string} language the language to generate protos in.
 */
ApiRepo.prototype._makeProtocFunc = function _makeProtocFunc(opts, language) {
  var that = this;
  opts = opts || {};
  opts.env = opts.env || this.opts.env || process.env;

  // callProtoc invokes protoc for the given language
  function callProtoc(protoPath, done) {
    if (that.languages.indexOf(language) == -1) {
      console.error('language not setup -', language, 'is not in',
                    that.languages);
      done(new Error('invalid language'));
      return;
    }
    var outDir = path.join(that.outDir, language);
    fs.mkdirsSync(outDir);
    var args = [];
    if (language === 'go') {
      args.push('--' + language + '_out=plugins=grpc:' + outDir);
    } else {
      var pluginOption = '--plugin=protoc-gen-grpc=';
      if (language === 'php') {
        // The php protoc plugin will generate php files for imported protos
        // (which will be common APIs) without the skip-imported flag. Other
        // plugins have this behaviour by default. Php does not use
        // protoc-gen-grpc plugin.
        args.push('--' + language + '_out=skip-imported=true:' + outDir);
        pluginOption = '--plugin=';
      } else {
        args.push('--' + language + '_out=' + outDir, '--grpc_out=' + outDir);
      }
      if (!opts.buildCommonProtos) {
        var pluginBin = that.depBins[that._getPluginName(language, that.overridePlugins)];
        args.push(pluginOption + pluginBin);
      }
      args.push('-I.');
      _.each(that.includePath, function(aPath) {
        args.push('-I' + aPath);
      });
    }
    args.push(protoPath);

    // Spawn the protoc command.
    console.log('exec: protoc %s\n in %s', args, that.repoDir);
    var proc = child_process.execFile('protoc', args, {
      cwd: that.repoDir,
      env: opts.env
    }, done);
  }

  return callProtoc;
};

/**
 * Helps construct a JSON representation each proto file for the nodejs build.
 *
 * @param {object} opts provides configuration info
 * @param {object} opts.root a virtual root folder that contains all the protos
 * @param {object} opts.path an array of folders where other protos reside
 *
 * @return {object} a ProtoBuf.Builder containing loaded representations of the
 * protos
 */
var loadProtos = function loadProtos(filenames, opts) {
  opts = opts || [];
  var builder = ProtoBuf.newBuilder(),
  loaded = [];
  builder.importRoot = opts.root;
  filenames.forEach(function(filename) {
    var data = pbjs.sources.proto.load(filename, opts, loaded);
    builder["import"](data, filename);
  });
  builder.resolveAll();
  return builder;
};

/**
 * Replace isDescriptor with a version that always returns false.
 *
 * pbjs/util.isDescriptor excludes imports that in google/protobuf.
 *
 * However, the nodejs packages need to be self-contained, so we actually want
 * to include these.
 */
pbjs_util.isDescriptor = function(name) {
  return false;
};
