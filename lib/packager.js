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
var config = require('./config');
var fs = require('fs-extra');
var path = require('path');
var glob = require('glob');

var Mustache = require('mustache');

exports.go = makeGolangPackage;
exports.java = makeJavaPackage;
exports.nodejs = makeNodejsPackage;
exports.objc = makeObjcPackage;
exports.python = makePythonPackage;
exports.ruby = makeRubyPackage;
exports.php = makePhpPackage;

var settings = {
  'go': {
    'copyables': [
      'PUBLISHING.md',
      '../LICENSE'
    ]
  },
  'java': {
    'copyables': [
      'gradle/wrapper/gradle-wrapper.jar',
      'gradle/wrapper/gradle-wrapper.properties',
      'gradlew',
      'gradlew.bat',
      'PUBLISHING.md',
      '../LICENSE'
    ],
    'templates': [
      'build.gradle.mustache',
      'build-alt.gradle.mustache',
      'settings.gradle.mustache'
    ]
  },
  'nodejs': {
    'copyables': [
      'PUBLISHING.md',
      '../LICENSE',
      'index.js'
    ],
    'templates': [
      'README.md.mustache',
      'index.js.mustache',
      'package.json.mustache'
    ]
  },
  'objc': {
    'copyables': [
      'PUBLISHING.md',
      '../LICENSE'
    ],
    'templates': [
      'podspec.mustache'
    ]
  },
  'python': {
    'copyables': [
      'PUBLISHING.rst',
      'MANIFEST.in',
      'tox.ini',
      'setup.cfg',
      '../LICENSE'
    ],
    'templates': [
      'README.rst.mustache',
      'setup.py.mustache',
      'requirements.txt.mustache',
      'docs/conf.py.mustache',
      'docs/index.rst.mustache',
      'docs/apis.rst.mustache',
      'docs/starting.rst.mustache'
    ]
  },
  'ruby': {
    'copyables': [
      'Gemfile',
      'PUBLISHING.md',
      '../LICENSE',
      'Rakefile'
    ],
    'templates': [
      'README.md.mustache',
      'gemspec.mustache'
    ]
  },
  'php': {
    'copyables': [
      'PUBLISHING.md',
      '../LICENSE'
    ],
    'templates': [
      'README.md.mustache',
      'composer.json.mustache'
    ]
  }
};

/**
 * makeGolangPackage creates a Go package.
 *
 * @param {object} opts contains settings used to configure the package.
 * @param {function} done is called once the package is created.
 */
function makeGolangPackage(opts, done) {
  opts = _.merge({}, settings.go, opts);
  var tasks = [];

  // Move copyable files to the top-level dir.
  opts.copyables.forEach(function(f) {
    var src = path.join(opts.templateDir, f)
    , dst = path.join(opts.top, f);
    if (f === '../LICENSE') {
      dst = path.join(opts.top, 'LICENSE');
    }
    tasks.push(checkedCopy(src, dst));
  });

  async.parallel(tasks, function(err) {
    if (!err && opts.copyables.indexOf('PUBLISHING.md') != -1) {
      console.log('The golang package', pkgName(opts.packageInfo),
                  'was created in', opts.top);
      console.log('To publish it, read', path.join(opts.top, 'PUBLISHING.md'),
                  'for the next steps');
    }
    done(err);
  });
}

function pkgName(packageInfo) {
  var name = packageInfo.api.name;
  if (packageInfo.api.version) {
    name += '-' + packageInfo.api.version;
  }
  return name;
}

function removeMustacheExt(filePath) {
  var extIndex = filePath.lastIndexOf('.mustache');
  if (extIndex === -1) {
    return filePath;
  }
  return filePath.slice(0, extIndex);
}

/**
 * makePythonPackage creates a new python package.
 *
 * @param {object} opts contains settings used to configure the package.
 * @param {function} done is called once the package is created.
 */
function makePythonPackage(opts, done) {
  opts = _.merge({}, settings.python, opts);
  var tasks = [];

  // Move copyable files to the top-level dir.
  opts.copyables.forEach(function(f) {
    var src = path.join(opts.templateDir, f)
    , dst = path.join(opts.top, f);
    if (f === '../LICENSE') {
      dst = path.join(opts.top, 'LICENSE');
    }
    tasks.push(checkedCopy(src, dst));
  });

  var nsPackages = [];
  var knownNamespaces = config.pythonPkg(opts).namespaces;

  function add1Pkg(pkgDir) {
    var dst = path.join(opts.top, pkgDir, '__init__.py');
    var src = path.join(opts.templateDir, '__init__.py');
    var basename = path.basename(pkgDir);

    // Rule for deciding when to create a namespace package
    //
    // - when building common protos, only those dirs that are 'known'
    // namespaces into namespace packages
    //
    // - when building normal services, ignore the version dir which is a
    // namespace package and ignore google.protobuf, which make occur when
    // building gax packages
    var pkg = pkgDir.replace(/\/$/, '').replace(/\//g, '.');
    if (opts.buildCommonProtos && _.contains(knownNamespaces, pkg)) {
      src = path.join(opts.templateDir, 'namespace__init__.py');
      nsPackages.push(pkg);
    }
    if (!opts.buildCommonProtos &&
        basename !== opts.packageInfo.api.version &&
        pkg !== 'google.protobuf') {
      src = path.join(opts.templateDir, 'namespace__init__.py');
      nsPackages.push(pkg);
    }
    fs.copySync(src, dst);
  }

  /**
   * ensureValidPackage ensures that the directory is a good python package.
   *
   * It adds
   * - the required python __init__.py files to each directory in the
   * python package
   * - identifies and lists the namespace packages
   * - identifies and modules present; these may be needed for docs
   *
   * All directories beneath opts.top must be python packages; this function
   * adds the necessary  __init__.py fields.
   */
  function ensureValidPackage(next) {
    console.log('setting up python package in: %s', opts.top);

    function listModules(err, modules) {
      if (err) {
        next(err);
      } else {
        var dotted = _.map(modules, function(m) {
          return m.replace(/.py$/, '').replace(/\//g, '.');
        });
        opts.packageInfo.api.apiModules = _.filter(dotted, function(m) {
          return !m.endsWith('_pb2');
        });
        opts.packageInfo.api.typeModules = _.filter(dotted, function(m) {
          return m.endsWith('_pb2');
        });
        next(null);
      }
    }

    function addPkgs(err, pkgDirs) {
      if (err) {
        next(err);
      } else {
        _.each(pkgDirs, add1Pkg);
        opts.packageInfo.api.nsPackages = nsPackages;

        // Add the list of modules
        glob.glob("**/*.py", {
          cwd: opts.top,
          ignore: ['**/__init__.py', 'example.py', 'setup.py']
        }, listModules);
      }
    }

    glob.glob("**/", { cwd: opts.top }, addPkgs);
  }
  tasks.push(ensureValidPackage);

  // Move the expanded files to the top-level dir.
  opts.templates.forEach(function(f) {
    var dstBase = removeMustacheExt(f);
    var tmpl = path.join(opts.templateDir, f)
    , dst = path.join(opts.top, dstBase);
    tasks.push(expand(tmpl, dst, opts.packageInfo));
  });

  async.series(tasks, function(err) {
    if (!err && opts.copyables.indexOf('PUBLISHING.rst') != -1) {
      console.log('The python package', pkgName(opts.packageInfo),
                  'was created in', opts.top);
      console.log('To publish it, read', path.join(opts.top, 'PUBLISHING.rst'),
                  'for the next steps');

    }
    done(err);
  });
}

/**
 * makeJavaPackage creates a new java package.
 *
 * @param {object} opts contains settings used to configure the package.
 * @param {function} done is called once the package is created.
 */
function makeJavaPackage(opts, done) {
  opts = _.merge({}, settings.java, opts);
  var tasks = [];

  // Move copyable files to the top-level dir.
  opts.copyables.forEach(function(f) {
    var src = path.join(opts.templateDir, f)
    , dst = path.join(opts.top, f);
    if (f === '../LICENSE') {
      dst = path.join(opts.top, 'LICENSE');
    }
    tasks.push(checkedCopy(src, dst));
  });

  // Move the expanded files to the top-level dir.
  opts.templates.forEach(function(f) {
    var dstBase = removeMustacheExt(f);
    if (opts.altJava) {
      if (dstBase === 'build.gradle') {
        return;  // don't expand the normal build.gradle
      }
      if (dstBase === 'build-alt.gradle') {
        dstBase = 'build.gradle';  // Use the alt build.gradle
      }
    } else if (dstBase === 'build-alt.gradle') {
      return;  // normally, don't expand the alt build.gradle
    }
    var tmpl = path.join(opts.templateDir, f)
    , dst = path.join(opts.top, dstBase);
    tasks.push(expand(tmpl, dst, opts.packageInfo));
  });

  async.parallel(tasks, function(err) {
    if (!err && opts.copyables.indexOf('PUBLISHING.md') != -1) {
      console.log('The java package', pkgName(opts.packageInfo), 'was created in',
                  opts.top);
      console.log('To publish it, read', path.join(opts.top, 'PUBLISHING.md'),
                  'for the next steps');
    }
    done(err);
  });
}

/**
 * makeNodejsPackage creates a new nodejs package.
 *
 * @param {object} opts contains settings used to configure the package.
 * @param {function} done is called once the package is created.
 */
function makeNodejsPackage(opts, done) {
  opts = _.merge({}, settings.nodejs, opts);
  var tasks = [];

  if (!opts.packageInfo.nodejsUsePbjs) {
    opts.templates.push('service.js.mustache');
  }
  // Move copyable files to the top-level dir.
  opts.copyables.forEach(function(f) {
    var src = path.join(opts.templateDir, f)
    , dst = path.join(opts.top, f);
    if (f === '../LICENSE') {
      dst = path.join(opts.top, 'LICENSE');
    }
    tasks.push(checkedCopy(src, dst));
  });

  // Move the expanded files to the top-level dir.
  opts.templates.forEach(function(f) {
    var dstBase = removeMustacheExt(f);
    var tmpl = path.join(opts.templateDir, f)
    , dst = path.join(opts.top, dstBase);
    tasks.push(expand(tmpl, dst, opts.packageInfo));
  });

  function runTask(err, jsFiles) {
    if (err) {
      done(err);
      return;
    }
    opts.packageInfo.apiFiles = _.map(jsFiles, function(jsFile) {
      return jsFile.replace(/\.js$/, '');
    });
    async.series(tasks, function(err) {
      if (!err && opts.copyables.indexOf('PUBLISHING.md') != -1) {
        console.log('The nodejs package', pkgName(opts.packageInfo),
                    'was created in', opts.top);
        console.log('To publish it, read', path.join(opts.top, 'PUBLISHING.md'),
                    'for the next steps');
      }
      done(err);
    });
  }

  // find lib/*.js files for gax API packages to generate index.js properly.
  if (opts.mockApiFilesForTest) {
    // For tests, mock data is passed instead of scanning the filesystem.
    runTask(null, opts.mockApiFilesForTest);
  } else {
    glob.glob('*.js', {cwd: path.join(opts.top, 'lib')}, runTask);
  }
}

/**
 * makeObjcPackage creates a new objective-c package.
 *
 * @param {object} opts contains settings used to configure the package.
 * @param {function} done is called once the package is created.
 */
function makeObjcPackage(opts, done) {
  opts = _.merge({}, settings.objc, opts);
  var tasks = [];

  // Move copyable files to the top-level dir.
  opts.copyables.forEach(function(f) {
    var src = path.join(opts.templateDir, f)
    , dst = path.join(opts.top, f);
    if (f === '../LICENSE') {
      dst = path.join(opts.top, 'LICENSE');
    }
    tasks.push(checkedCopy(src, dst));
  });

  // Move the expanded files to the top-level dir.
  var packageName = pkgName(opts.packageInfo);
  opts.templates.forEach(function(f) {
    var dstBase = f;
    if (dstBase === 'podspec.mustache') {
      dstBase = packageName + '.podspec';
    }
    var tmpl = path.join(opts.templateDir, f)
    , dst = path.join(opts.top, dstBase);
    tasks.push(expand(tmpl, dst, opts.packageInfo));
  });

  async.parallel(tasks, function(err) {
    if (!err && opts.copyables.indexOf('PUBLISHING.md') != -1) {
      console.log('The objective-c package', packageName,
                  'was created in', opts.top);
      console.log('To publish it, read', path.join(opts.top, 'PUBLISHING.md'),
                  'for the next steps');
    }
    done(err);
  });
}

/**
 * makeRubyPackage creates a new ruby package.
 *
 * @param {object} opts contains settings used to configure the package.
 * @param {function} done is called once the package is created.
 */
function makeRubyPackage(opts, done) {
  /**
   * Collect the primary class names for the (gax) API package, and invoke done
   * with the list of objects whose 'name' is the name of the ruby class and
   * 'path' is the pathname in YARD-style document.
   * The result will be referred from README.md file of the generated document,
   * so that the users can quickly find the primary entry points of the package.
   */
  function collectApiClasses(done) {
    var apiClasses = [];
    function underscoreToCamelCase(str) {
      return _.map(str.split('_'), function(segment) {
        return segment.charAt(0).toUpperCase() + segment.slice(1);
      }).join('');
    }
    function rbFileToData(rbFile) {
      var pathComponents = _.map(
          rbFile.replace(/\.rb$/, '').split('/'), underscoreToCamelCase);
      return {'name': pathComponents.join('::'),
              'path': pathComponents.join('/')};
    }
    glob.glob("**/*.rb", {cwd: path.join(opts.top, 'lib'),
                          ignore: "**/doc/**/*.rb"},
              function(err, rbFiles) {
                if (err) {
                  done(err);
                } else {
                  done(null, _.map(rbFiles, rbFileToData));
                }
              });
  }

  opts = _.merge({}, settings.ruby, opts);
  fs.mkdirsSync(path.join(opts.top, 'lib'));

  collectApiClasses(function(err, apiClasses) {
    if (err) {
      done(err);
      return;
    }
    var tasks = [];
    opts.packageInfo.api.apiClasses = apiClasses;

    // Move the generated files to the lib dir.
    opts.generated = opts.generated || [];
    opts.generated.forEach(function(f) {
      var src = path.join(opts.top, f)
      , dst = path.join(opts.top, 'lib', f);
      tasks.push(fs.move.bind(fs, src, dst));
    });

    // Move copyable files to the top-level dir.
    opts.copyables.forEach(function(f) {
      var src = path.join(opts.templateDir, f)
      , dst = path.join(opts.top, f);
      if (f === '../LICENSE') {
        dst = path.join(opts.top, 'LICENSE');
      }
      tasks.push(checkedCopy(src, dst));
    });

    // Move the expanded files to the top-level dir.
    var packageName = pkgName(opts.packageInfo);
    opts.templates.forEach(function(f) {
      var dstBase = removeMustacheExt(f);
      if (dstBase === 'gemspec') {
        dstBase = packageName + '.gemspec';
      }
      var tmpl = path.join(opts.templateDir, f)
      , dst = path.join(opts.top, dstBase);
      tasks.push(ifExists(tmpl, expand(tmpl, dst, opts.packageInfo)));
    });

    async.parallel(tasks, function(err) {
      if (!err && opts.copyables.indexOf('PUBLISHING.md') != -1) {
        console.log('The ruby package', packageName, 'was created in',
                    opts.top);
        console.log('To publish it, read', path.join(opts.top, 'PUBLISHING.md'),
                    'for the next steps');
      }
      done(err);
    });
  });
}

/**
 * makePhpPackage creates a new php package.
 *
 * @param {object} opts contains settings used to configure the package.
 * @param {function} done is called once the package is created.
 */
function makePhpPackage(opts, done) {
  opts = _.merge({}, settings.php, opts);
  var tasks = [];

  // Move copyable files to the top-level dir.
  opts.copyables.forEach(function(f) {
    var src = path.join(opts.templateDir, f)
    , dst = path.join(opts.top, f);
    if (f === '../LICENSE') {
      dst = path.join(opts.top, 'LICENSE');
    }
    tasks.push(checkedCopy(src, dst));
  });

  // Move the expanded files to the top-level dir.
  var packageName = pkgName(opts.packageInfo);
  opts.templates.forEach(function(f) {
    var dstBase = removeMustacheExt(f);
    var tmpl = path.join(opts.templateDir, f)
    , dst = path.join(opts.top, dstBase);
    tasks.push(expand(tmpl, dst, opts.packageInfo));
  });

  async.series(tasks, function(err) {
    if (!err && opts.copyables.indexOf('PUBLISHING.md') != -1) {
      console.log('The php package', packageName, 'was created in',
                  opts.top);
      console.log('To publish it, read', path.join(opts.top, 'PUBLISHING.md'),
                  'for the next steps');
    }
    done(err);
  });
}

function checkedCopy(src, dst)  {
  function loggedCopy(done) {
    console.log('copying %s => %s', src, dst);
    fs.mkdirs(path.dirname(dst), function(err) {
      if (err) {
        done(err);
      } else {
        fs.copy(src, dst, done);
      }
    });
  }

  return ifExists(src, loggedCopy);
}

/**
 * Expands the contents of a template file, saving it to an output file.
 *
 * @param {string} template the path to the template file
 * @param {string} dst the path of the expanded output
 * @param {Object} params object containing the named parameter values
 * @param {function(Error, string)} done is called with the rendered template
 */
function expand(template, dst, params) {
  // render and save the output file
  function render(done, err, renderable) {
    if (err) {
      console.error('Expansion of %s to %s failed with %s',
                    template, dst, err);
      done(err);
    } else {
      fs.mkdirs(path.dirname(dst), function(err) {
        if (err) {
          done(err);
        } else {
          console.log('rendering %s', dst);
          fs.writeFile(dst, Mustache.render(renderable, params), done);
        }
      });
    }
  }

  return ifExists(template, function(done) {
    fs.readFile(template, {encoding: 'utf-8'}, render.bind(null, done));
  });
}

function ifExists(filename, proc) {
  return function(done) {
    fs.access(filename, function(err) {
      if (err) {
        done();
      } else {
        proc(done);
      }
    });
  };
}
