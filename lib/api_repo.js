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
var execFile = require('child_process').execFile;
var config = require('./config');
var fs = require('fs-extra');
var glob = require('glob');
var packager = require('./packager');
var path = require('path');
var pbjs = require('protobufjs/cli/pbjs');
var pbjsUtil = require('protobufjs/cli/pbjs/util');
var readline = require('readline');
var request = require('request');
var tmp = require('tmp');

var EventEmitter = require('events').EventEmitter;
var ProtoBuf = require('protobufjs');
var StreamZip = require('node-stream-zip');

exports.ApiRepo = ApiRepo;

var GOOGLE_APIS_REPO_ZIP =
    'https://github.com/googleapis/googleapis/archive/master.zip';

exports.GOOGLE_APIS_REPO_ZIP = GOOGLE_APIS_REPO_ZIP;

var DEFAULT_LANGUAGES = [
  'go',
  'objc',
  'nodejs',
  'python',
  'ruby',
  'php'
];

var DEFAULT_PROTO_COMPILER = 'protoc';

// nodejs builds using ProtoBuf.js. The Java package just copies protos.
// Python builds using grpcio-tools.
var NO_PROTOC_PLUGIN = ['nodejs', 'java', 'python'];

// the default include path, where install the protobuf runtime installs its
// protos.
var DEFAULT_INCLUDE_PATH = Object.freeze(['/usr/local/include']);

/**
 * ApiRepo represents a published repo containing API protos.
 * @param {?Object} opts - The optional parameters.
 * @constructor
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
  this.repoDirs = opts.repoDirs || [];
  this.templateRoot = opts.templateRoot;
  this.protoCompiler = opts.protoCompiler || DEFAULT_PROTO_COMPILER;
  this.protoCompilerArgs = opts.protoCompilerArgs || '';
  this.pkgPrefix = opts.pkgPrefix;
  this.overridePlugins = opts.overridePlugins;
  this.zipUrl = opts.zipUrl;
  this.isGoogleApi = (!!opts.buildCommonProtos && !opts.altJava);
  if (_.isEmpty(this.repoDirs) && !this.zipUrl) {
    this.zipUrl = GOOGLE_APIS_REPO_ZIP; // default to download googleapis
    this.isGoogleApi = true;
  }
}
ApiRepo.prototype =
    Object.create(EventEmitter.prototype, {constructor: {value: ApiRepo}});

/**
 * setUp prepares an ApiRepo for use.
 *
 * After it is called, build packages in the repo's 'ready' event.
 * It ensures that
 * - the binaries needed to complete code generation are already available
 * - the configured api repository is valid and available.
 *
 * repo = new ApiRepo({
 *   repoDirs: ['path/to/name/version']
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
    if (err) {
      this.emit('error', err);
    } else {
      this.emit('ready');
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
 * @param {object[]} templateInfo - The list of objects about template.
 * @param {string} root - The root directory for the template.
 * @return {object[]} The copied template Info.
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
 *   repoDirs: ['path/to/name/version']
 *   languages: ['python', 'ruby']
 * });
 * repo.on('ready', function() {
 *   repo.buildPackages(name, version);  // called then the repo is ready
 * });
 * repo.on('err', function(err) {
 *   console.error('Could not build packages:', err);
 * });
 * repo.setUp();
 * @param {string} name - The API name.
 * @param {string} version - The API version.
 * @param {?function(?Error)} optDone - Optional callback.
 */
ApiRepo.prototype.buildPackages =
    function buildPackages(name, version, optDone) {
      var tasks = [];
      var that = this;
      var done = this._wrapDone(optDone);
      var altJava = this.opts.altJava;

      var templateInfo = rootTemplateDir(
          defaultTemplateInfo, this.templateRoot);
      this.languages.forEach(function(l) {
        var makePackageTasks = [that._buildProtos.bind(that, name, version, l)];
        if (packager[l]) {
          var buildAPackage = function buildAPackage(generated, next) {
            var opts = _.merge({
              altJava: altJava,
              top: path.join(that.outDir, l),
              packageInfo: that.packageInfo,
              generated: generated
            }, templateInfo[l]);
            if (l === 'nodejs' && !that.opts.nodejsUsePbjs) {
              opts.packageInfo.protoFiles = _.filter(generated, function(file) {
                return file.match(/\.proto$/);
              });
              opts.packageInfo.nodejsUseProtos = true;
            }
            var cleanName = name.replace(new RegExp('/', 'g'), '-');
            opts.packageInfo.api.simplename = cleanName;
            opts.packageInfo.api.path =
                cleanName.replace(new RegExp('-', 'g'), '/');
            opts.packageInfo.api.name = that.pkgPrefix + cleanName;
            opts.packageInfo.api.version = version;
            if (version) {
              opts.packageInfo.api.fullName =
                  opts.packageInfo.api.name + '-' + version;
            } else {
              opts.packageInfo.api.fullName = opts.packageInfo.api.name;
            }
            var semver = opts.packageInfo.api.semver[l];
            if (semver) {
              /* eslint-disable camelcase */
              opts.packageInfo.api.semantic_version = semver;
              /* eslint-enable camelcase */
            }
            if (that.opts.protoGenPackageDeps) {
              // TODO convert to a method which allows for differing logic
              // between languages (e.g. Python/Ruby don't use the prefix
              // for googleapis-common-protos)
              opts.packageInfo.api.protoGenPackageDeps =
                  that.opts.protoGenPackageDeps.map(function(dep) {
                    return that.pkgPrefix + dep;
                  });
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
 *   repoDirs: ['path/to/name/version']
 *   languages: ['python', 'ruby']
 * });
 * repo.on('ready', function() {
 *   repo.buildGaxPackages(name, version);  // called then the repo is ready
 * });
 * repo.on('err', function(err) {
 *   console.error('Could not build gax packages:', err);
 * });
 * repo.setUp();
 * @param {string} name - The API name.
 * @param {string} version - The API version.
 * @param {?function(?Error)} optDone - The optional callback.
 */
ApiRepo.prototype.buildGaxPackages =
    function buildGaxPackages(name, version, optDone) {
      var tasks = [];
      var that = this;
      var done = this._wrapDone(optDone);

      var templateRoot = path.join(__dirname, '..', 'templates', 'gax');
      var templateInfo = rootTemplateDir(defaultTemplateInfo, templateRoot);
      var numLanguages = this.languages.length;
      this.languages.forEach(function(l) {
        if (packager[l]) {
          var buildAPackage = function buildAPackage(next) {
            var top = path.join(that.outDir, l);
            if (numLanguages === 1) {
              top = that.outDir;
            }
            var opts = _.merge({
              top: top,
              packageInfo: that.packageInfo
            }, templateInfo[l]);
            var cleanName = name.replace(new RegExp('/', 'g'), '-');
            var pkgName = that.pkgPrefix + cleanName;
            var shortName = name.split('/').slice(-1)[0];
            var titleName = shortName[0].toUpperCase() + shortName.slice(1);
            opts.packageInfo.api.simplename = cleanName;
            opts.packageInfo.api.path = cleanName.replace(/-/g, '/');
            opts.packageInfo.api.name = pkgName;
            opts.packageInfo.api.dependsOn = pkgName.replace('gax', 'grpc');
            opts.packageInfo.api.titlename = titleName;
            opts.packageInfo.api.shortname = shortName;
            opts.packageInfo.api.version = version;
            var semver = opts.packageInfo.api.semver[l];
            if (semver) {
              /* eslint-disable camelcase */
              opts.packageInfo.api.semantic_version = semver;
              /* eslint-enable camelcase */
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
 * _wrapDone wraps the optional 'done' callback used in the buildXXX methods,
 * ensuring that errors trigger the error event.
 * @param {?function(?Error)} optDone - The optional callback.
 * @return {function(?Error)} a function which can be used as a callback.
 */
ApiRepo.prototype._wrapDone = function _wrapDone(optDone) {
  return function done(err) {
    if (err) {
      this.emit('error', err);
    }
    if (optDone) {
      optDone(err);
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
 *   repoDirs: ['path/to/name/version']
 *   languages: ['python', 'ruby']
 * });
 * repo.on('ready', function() {
 *   repo.buildCommonProtoPkgs(name, version);  // repo is ready
 * });
 * repo.on('err', function(err) {
 *   console.error('Could not build packages:', err);
 * });
 * repo.setUp();
 * @param {?function(?Error)} optDone - The optional callback.
 */
ApiRepo.prototype.buildCommonProtoPkgs =
    function buildCommonProtoPkgs(optDone) {
      var tasks = [];
      var that = this;
      var altJava = this.opts.altJava;
      var done = this._wrapDone(optDone);

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
              altJava: altJava,
              buildCommonProtos: true,
              top: path.join(that.outDir, l),
              packageInfo: that.packageInfo,
              generated: _.union(_.flatten(allGenerated))
            }, templateInfo[l]);
            opts.packageInfo.api.name = that.pkgPrefix;
            /* eslint-disable camelcase */
            opts.packageInfo.api.semantic_version = that.commonPb.semver;
            /* eslint-enable camelcase */
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
 * @param {string[]} includePath - The list of include path of protoc.
 * @param {string} protoFile - The target .proto file.
 * @param {function(?Error, string[])} done - The callback.
 */
ApiRepo.prototype._collectProtoDeps = function _collectProtoDeps(
    includePath, protoFile, done) {
  var deps = tmp.fileSync();
  var desc = tmp.fileSync();
  var args = this.protoCompilerArgs.concat(
      ['--dependency_out=' + deps.name, '-o', desc.name]);
  if (includePath) {
    includePath.forEach(function(ipath) {
      args.push('-I', ipath);
    });
  }
  args.push(protoFile);
  // Invokes protoc with --dependency_out to generate the dependency
  // proto files.
  execFile(this.protoCompiler, args, {}, function(err) {
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
};

/**
 * Create the mapping of the .proto file source to the destination.
 *
 * This is a sub task of 'ProtoBased' nodeJS module in _buildProtos, but
 * extracted as a method for the testing.
 *
 * @param {Array.<Array<string>>} fileLists - - the list of the lists of the
 *   .proto files to be copied. Each item is the list of .proto files calculated
 *   by _collectProtoDeps.
 * @param {string[]} includePath - - the list of include paths used for protoc.
 * @return {Object} - an object whose keys are the source files (i.e. items
 *   in fileList) and values are the path of the files relative to
 *   the output destinations.
 */
ApiRepo.prototype._buildProtoFilesMapping = function _buildProtoFilesMapping(
    fileLists, includePath) {
  var filesMap = {};
  fileLists.forEach(function(fileList) {
    fileList.forEach(function(filePath) {
      if (filePath in filesMap) {
        return;
      }
      for (var i = 0; i < includePath.length; ++i) {
        if (filePath.indexOf(includePath[i]) === 0) {
          var relativePath = filePath.slice(includePath[i].length + 1);
          filesMap[filePath] = path.join(relativePath);
          return;
        }
      }
      // Files under google/protobuf might not be found in the includePath but
      // in the default location (such as /usr/include), however the actual
      // location is not known without running protoc actually. Here finds the
      // pattern of google/protobuf/*.proto and crete the mapping from the
      // file path.
      var matched = filePath.match(/\bgoogle\/protobuf\/[^\/]*.proto$/);
      if (matched) {
        filesMap[filePath] = path.join(matched[0]);
      } else {
        console.warn('Unexpected dependency file: ' + filePath);
      }
    });
  });
  return filesMap;
};

/**
 * _buildProtos builds the protos for named api and version in the target languages.
 *
 * @param {string} name - the api name
 * @param {string} version - the api version
 * @param {string} language - language to generate protos in
 * @param {function(?Error)} done - the function to run on protoc completion
 */
ApiRepo.prototype._buildProtos =
    function _buildProtos(name, version, language, done) {
      var langTopDir = path.join(this.outDir, language);

      /**
       * findOutputs lists the files in the output directory.
       * @param {?Error} err - The error if failed.
       */
      function findOutputs(err) {
        if (err) {
          console.error('findOutputs:start:err', err);
          done(err);
        } else {
          var stripRoot = processPaths(done, function(paths) {
            return _.map(paths, function(x) {
              return x.replace(langTopDir, '');
            });
          });
          glob.glob("**", {
            cwd: langTopDir,
            nodir: true
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
         * @param {string} repoDir - the path to the directory containing the
         *   proto.
         * @param {string} protoPath - the path of .proto file relative to the
         *   repoDir.
         * @param {function(?Error)} next - The callback.
         */
        var copyJavaPb = function copyJavaPb(repoDir, protoPath, next) {
          computePkg(repoDir, protoPath, function(pkg) {
            var src = path.join(repoDir, protoPath);
            var dst = path.join(dstResourceDir, pkg, protoPath);
            fs.copy(src, dst, next);
          });
        };
        this._findProtos(name, version, findOutputs, copyJavaPb);
      } else if (language === 'nodejs') {
        /**
         * makeProtoBasedNodeModule finds the required .proto files for the API
         * and copies them into the output directory.
         * @param {string[]} fullPathProtos - The list of absolute paths of .proto
         *   files.
         * @param {string[]} includePath - The list of include paths for protoc.
         */
        var makeProtoBasedNodeModule =
            function makeProtoBasedNodeModule(fullPathProtos, includePath) {
              var outDir = path.join(langTopDir, 'proto');
              async.map(
                  fullPathProtos,
                  this._collectProtoDeps.bind(null, includePath),
                  function(err, fileLists) {
                    if (err) {
                      findOutputs(err);
                      return;
                    }
                    var filesMap = this._buildProtoFilesMapping(
                        fileLists, includePath);
                    async.forEachOf(filesMap, function(dst, src, next) {
                      var finalDst = path.join(outDir, dst);
                      fs.mkdirsSync(path.dirname(finalDst));
                      fs.copy(src, finalDst, next);
                    }, findOutputs);
                  }.bind(this));
            }.bind(this);
        /**
         * makeNodeModule writes a commonJS module containing all the protos
         * used by service.
         * @param {?Error} err - Failure if specified.
         * @param {string[]} allProtos - The list of all proto files.
         */
        var makeNodeModule = function makeNodeModule(err) {
          if (err !== null) {
            findOutputs(err);
            return;
          }

          // TODO: this requires calling _findProtos twice, when it should be
          // possible to do it in one go.
          var that = this;
          var fullPathProtos = [];
          function makeModule() {
            var includePath = _.union(that.includePath, that.repoDirs);
            if (!that.opts.nodejsUsePbjs) {
              makeProtoBasedNodeModule(fullPathProtos, includePath);
              return;
            }
            var opts = {
              root: that.repoDirs,
              source: 'proto',
              path: includePath
            };

            var builder = loadProtos(fullPathProtos, opts);
            var outDir = path.join(that.outDir, language);
            fs.mkdirsSync(outDir);
            var servicePath = path.join(outDir, 'service.js');
            var commonJS = pbjs.targets.commonjs(builder, opts);
            fs.writeFile(servicePath, commonJS, findOutputs);
          }

          this._findProtos(
              name, version, makeModule,
              function(protoDir, proto, next) {
                fullPathProtos.push(path.join(protoDir, proto));
                next();
              }
          );
          makeModule();
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

ApiRepo.prototype._getPluginName = function _getPluginName(
    lang, overridePlugins) {
  if (_.has(overridePlugins, lang)) {
    return overridePlugins[lang];
  } else if (_.has(defaultPluginName, lang)) {
    return defaultPluginName[lang];
  }
  return 'grpc_' + lang + '_plugin';
};

/**
 * _checkDeps confirms that the tools needed to generate the required protos
 * are present.
 * @param {Object} opts - The options.
 * @param {function(?Error)} done - The callback.
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
  var reqdBins = [this.protoCompiler];
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
  execFile('which', reqdBins, {env: opts.env}, isInPath);
};

/**
 * newIsDirFunc creates a function isDir(callback) that asynchronouosly
 * confirms if dirName is a directory.
 *
 * @param {string} dirName - the directory to check.
 * @return {function(?Error)} The function of doing the actual task.
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
 * Helper function for _checkRepo. Checks that the repoDirs target is available.
 * @param {function(?Error)} done - A callback to be called when the function
 *   finishes.
 */
ApiRepo.prototype._checkRepoDirs = function _checkRepoDirs(done) {
  var checkDirs = this.repoDirs.map(function(repoDir) {
    return newIsDirFunc(repoDir);
  });
  var checkGoogleDirs = [];
  if (this.isGoogleApi) {
    checkGoogleDirs = this.repoDirs.map(function(repoDir) {
      return newIsDirFunc(path.join(repoDir, 'google'));
    });
  }
  async.waterfall(checkDirs.concat(checkGoogleDirs), done);
};

/**
 * Helper function for _checkRepo. Downloads zipUrl and configures repoDirs
 * to point to the contents of the zip.
 * @param {function(?Error)} done - A callback to be called when the function
 *   finishes.
 */
ApiRepo.prototype._checkRepoWithZipUrl = function _checkRepoWithZipUrl(done) {
  var that = this;
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
      postfix: '.zip'}, fileCb);
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
    zip.on('error', function(err) {
      next(err);
    });
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
  function updateRepoDirs(dirName, next) {
    fs.readdir(dirName, function(err, files) {
      if (err) {
        return next(err);
      }
      // TODO: support multiple top-level dirs in zip (since repoDirs can
      // contain multiple entries
      if (files.length > 1) {
        console.error('Malformed zip had', files.length, 'top-level dirs');
        return next(new Error('Malformed zip: more than 1 top-level dir'));
      }
      that.repoDirs = [path.join(dirName, files[0])];
      return next(null);
    });
  }
  function checkNewSubDir(callback) {
    // TODO: check all repoDirs.
    var checkGoogleDir = newIsDirFunc(path.join(that.repoDirs[0], 'google'));
    checkGoogleDir(callback);
  }
  var tasks = [
    makeTmpDir,    // make a tmp directory
    makeTmpZip,    // make a tmp file in which to save the zip
    saveZip,       // pull the zip archive and save it
    extractZip,    // extract the zip and save in the tmp directory
    updateRepoDirs // set the top-level dir of the extracted zip as repoDir
  ];
  if (this.isGoogleApi) {
    tasks.push(checkNewSubDir);  // check that the google dir is present.
  }
  async.waterfall(tasks, done);
};

/**
 * _checkRepo confirms that api repo source is available.
 *
 * if repoDirs is set, it confirms that the directories exists
 *
 * if repoDirs is not set, but zipUri is, it downloads the api zip to tmp dir
 * and sets repoDirs to be an array containing the derived source directory
 * (based on the API name and version) as its single element.
 *
 * if isGoogleApi is `true`, it confirms that each directory in repoDirs has
 * 'google' subdirectory
 * @param {function(?Error)} done - The callback.
 */
ApiRepo.prototype._checkRepo = function _checkRepo(done) {
  if (_.isEmpty(this.repoDirs)) {
    this._checkRepoWithZipUrl(done);
  } else {
    this._checkRepoDirs(done);
  }
};

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
 * @param {string} name - the api name
 * @param {string} version - the api version
 * @param {function(string[], ?Error)} done - the cb called with all the protos
     or an error
 * @param {function(string, string, function(?Error))} onProto - the callback
     called on each proto/protoDir pair
 */
ApiRepo.prototype._findProtos = function _findProtos(name, version, done,
                                                     onProto) {
  // Determine the top-level proto dir
  var protoDirs = this.repoDirs;

  if (this.isGoogleApi) {
    protoDirs = protoDirs.map(function(protoDir) {
      return path.join(protoDir, 'google');
    });
  }

  if (this.zipUrl) {
    protoDirs = protoDirs.map(function(protoDir) {
      return path.join(protoDir, name, version);
    });
  }

  function scanForProtos(next) {
    var protosByRoots = {};
    _.each(protoDirs, function(protoDir) {
      protosByRoots[protoDir] =
          glob.sync("*.proto", {
            cwd: protoDir,
            realpath: true,
            nodir: true
          });
    });
    next(null, protosByRoots);
  }

  /* Optionally process each proto/protoDir key-value pair, then run
   * callback on the values (i.e., proto files). */
  function actOnProtos(protosByRoots, next) {
    var getProtos = function(foundProtos) {
      return _.values(foundProtos);
    };

    if (onProto) {
      async.eachOf(
          protosByRoots,
          function(protos, root, outerCb) {
            var stripped = protos.map(function(proto) {
              return proto.replace(root + '/', '');
            });
            async.each(
                stripped,
                function(strippedProto, innerCb) {
                  onProto(root, strippedProto, innerCb);
                },
                outerCb);
          },
          function(err) {
            if (err) {
              next(err);
            } else {
              next(null, getProtos(protosByRoots));
            }
          });
    } else {
      next(null, getProtos(protosByRoots));
    }
  }

  async.waterfall(
      protoDirs.map(function(protoDir) {
        return newIsDirFunc(protoDir); // verify the proto dir exists
      }).concat(
        [
          scanForProtos,  // scan for proto files in it
          actOnProtos  // optionally process each proto in it
        ]),
      done);
};

// computeOutDir reads the package of a proto file
function computePkg(protoRepoDir, protoPath, done) {
  var file = readline.createInterface({
    input: fs.createReadStream(path.join(protoRepoDir, protoPath))
  });
  file.on('line', function(line) {
    var match = line.match('^package ([A-Za-z_]+(\\.[A-Za-z_0-9]+)*)');
    if (match) {
      var pkg = match[1].replace(/\./g, '/');
      done(pkg);
    }
  });
}

/**
 * _makeProtocFunc makes a function that calls the protoc command line on
 * a proto in a given languages.
 *
 * @param {object} opts - configure the call
 * @param {string} language - the language to generate protos in.
 * @return {function(string, string, function(?Error))} A function to invoke
 *   protoc command.
 */
ApiRepo.prototype._makeProtocFunc = function _makeProtocFunc(opts, language) {
  var that = this;
  opts = opts || {};
  opts.env = opts.env || this.opts.env || process.env;

  // callProtoc invokes protoc for the given language
  function callProtoc(repoDir, protoPath, done) {
    console.log('calling with repoDir', repoDir);
    computePkg(repoDir, protoPath, function(pkg) {
      callProtocWithOutDir(repoDir, protoPath, pkg, done);
    });
  }

  function callProtocWithOutDir(repoDir, protoPath, pkg, done) {
    var outDir = path.join(that.outDir, language);
    var dirUpCount = pkg.split("/").length;
    var protocCwd = path.join(repoDir, "../".repeat(dirUpCount));
    var checkDir = newIsDirFunc(path.join(protocCwd, pkg));

    function runProtoc() {
      if (that.languages.indexOf(language) === -1) {
        console.error('language not setup -', language, 'is not in',
                      that.languages);
        done(new Error('invalid language'));
        return;
      }
      fs.mkdirsSync(outDir);
      var args = that.protoCompilerArgs ? that.protoCompilerArgs.split(' ') : [];
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
          args.push('--' + language + '_out=' + outDir);
          if (!opts.buildCommonProtos) {
            args.push('--grpc_out=' + outDir);
          }
        }
        if (!(opts.buildCommonProtos ||
              _.includes(NO_PROTOC_PLUGIN, language))) {
          var pluginBin = that.depBins[
              that._getPluginName(language, that.overridePlugins)];
          args.push(pluginOption + pluginBin);
        }
        args.push('-I.');
        _.each(that.includePath, function(aPath) {
          args.push('-I' + aPath);
        });
      }
      args.push(path.join(pkg, protoPath));

      // Spawn the protoc command.
      console.log('exec: protoc %s\n in %s', args, repoDir);
      execFile(that.protoCompiler, args, {
        cwd: protocCwd,
        env: opts.env
      }, done);
    }

    checkDir(function(err) {
      if (err) {
        console.error('proto package did not match directory path: ', pkg);
        done(new Error('invalid path to proto'));
        runProtoc();
      } else {
        runProtoc();
      }
    });
  }

  return callProtoc;
};

/**
 * Helps construct a JSON representation each proto file for the nodejs build.
 *
 * @param {string[]} filenames - The list of files.
 * @param {object} opts - provides configuration info
 * @param {object} opts.root - a virtual root folder that contains all the protos
 * @param {object} opts.path - an array of folders where other protos reside
 *
 * @return {object} a ProtoBuf.Builder containing loaded representations of the
 * protos
 */
function loadProtos(filenames, opts) {
  opts = opts || [];
  var builder = ProtoBuf.newBuilder();
  var loaded = [];
  builder.importRoot = opts.root;
  filenames.forEach(function(filename) {
    var data = pbjs.sources.proto.load(filename, opts, loaded);
    builder.import(data, filename);
  });
  builder.resolveAll();
  return builder;
}

/**
 * Replace isDescriptor with a version that always returns false.
 *
 * pbjs/util.isDescriptor excludes imports that in google/protobuf.
 *
 * However, the nodejs packages need to be self-contained, so we actually want
 * to include these.
 * @param {string} name - The name of the message.
 * @return {Boolean} Whether it is a descriptor or not.
 */
pbjsUtil.isDescriptor = function(name) {
  return false;
};
