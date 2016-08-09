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
var diff = require('diff');
var fs = require('fs-extra');
var path = require('path');
var tmp = require('tmp');

var packager = require('../lib/packager');

var templateDirs = {
  go: {
    templateDir: path.join(__dirname, '..', 'templates', 'go')
  },
  java: {
    templateDir: path.join(__dirname, '..', 'templates', 'java')
  },
  nodejs: {
    templateDir: path.join(__dirname, '..', 'templates', 'nodejs')
  },
  objc: {
    templateDir: path.join(__dirname, '..', 'templates', 'objc')
  },
  python: {
    templateDir: path.join(__dirname, '..', 'templates', 'python')
  },
  ruby: {
    templateDir: path.join(__dirname, '..', 'templates', 'ruby')
  },
  php: {
    templateDir: path.join(__dirname, '..', 'templates', 'php')
  }
};

function filesEqual(file1, file2, done) {
  fs.readFile(file1, 'utf-8', function(err, file1Data) {
    if (err) {
      done(err);
      return;
    }
    fs.readFile(file2, 'utf-8', function(err, file2Data) {
      if (err) {
        done(err);
        return;
      }
      var diffs = diff.diffTrimmedLines(file1Data, file2Data);
      var diffCount = 0;
      diffs.forEach(function(d) {
        if (!!d.added || !!d.removed) {
          console.warn('Difference found ', d);
          diffCount += 1;
        }
      });
      if (diffCount === 0) {
        done();
      } else {
        console.log(diffs);
        if (diffCount === 1) {
          done(new Error('There was a difference'));
        } else {
          done(new Error('There were ' + diffCount + ' differences'));
        }
      }
    });
  });
}

function genFixtureCompareFunc(top, fixtureSubdirs) {
  var fixtureBase = ['fixtures'];
  if (fixtureSubdirs) {
    fixtureBase.push.apply(fixtureBase, fixtureSubdirs);
  }
  return function compareWithFixture(c) {
    var pathargs = fixtureBase.slice();
    pathargs.unshift(__dirname);
    pathargs.push(c);
    var want = path.join.apply(null, pathargs);
    var got = path.join(top, c);
    return filesEqual.bind(null, want, got);
  };
}

function genCopyCompareFunc(top) {
  return function checkACopy(c) {
    var want = path.join(__dirname, '..', 'templates', c);
    var got = path.join(top, c);
    return filesEqual.bind(null, want, got);
  };
}

/* eslint-disable camelcase */
var testPackageInfo = {
  api: {
    author: 'Google Inc',
    description: 'a unittest api',
    email: 'googleapis-packages@google.com',
    github_user_uri: 'https://github.com/google',
    homepage: 'https://github.com/google/googleapis',
    license: 'BSD-3-Clause',
    name: 'packager-unittest',
    simplename: 'packager',
    version: 'v2',
    semantic_version: '1.0.0'
  },
  dependencies: {
    protobuf: {
      objc: {
        version: '3.0.0-alpha-3'
      },
      nodejs: {
        version: '5.0.1'
      },
      java: {
        version: '3.0.0-beta-3'
      }
    },
    googleapis_common_protos: {
      python: {
        version: '1.2.0'
      },
      ruby: {
        version: '3.0.0b1.1'
      }
    },
    grpc: {
      core: {
        version: '0.9.0'
      },
      java: {
        version: '0.12.0'
      },
      nodejs: {
        version: '0.10.0'
      },
      objc: {
        ios: {
          deployment_target: '6.0'
        },
        osx: {
          deployment_target: '10.8'
        },
        version: '0.5.0'
      },
      python: {
        version: '0.15.0'
      },
      ruby: {
        version: '0.9.3'
      },
      php: {
        version: '0.14.1'
      }
    },
    auth: {
      python: {
        version: '0.4.1'
      },
      ruby: {
        version: '0.4.1'
      },
      nodejs: {
        version: '0.9.2'
      }
    }
  }
};
/* eslint-enable camelcase */

describe('the go package builder', function() {
  var top;
  beforeEach(function() {
    top = tmp.dirSync().name;
  });

  it('should construct a go package', function(done) {
    var opts = _.merge({
      packageInfo: testPackageInfo,
      top: path.join(top, 'go')
    }, templateDirs.go);
    var copies = [
      'go/PUBLISHING.md'
    ];
    var checkCopies = function checkCopies(next) {
      var checkACopy = genCopyCompareFunc(top);
      var copyTasks = _.map(copies, checkACopy);
      async.parallel(copyTasks, next);
    };
    async.series([
      packager.go.bind(null, opts),
      checkCopies
    ], done);
  });
});

describe('the objective c package builder', function() {
  var top;
  beforeEach(function() {
    top = tmp.dirSync().name;
  });

  it('should construct a objc package', function(done) {
    var opts = _.merge({
      packageInfo: testPackageInfo,
      top: path.join(top, 'objc')
    }, templateDirs.objc);
    var copies = [
      'objc/PUBLISHING.md'
    ];
    var checkCopies = function checkCopies(next) {
      var checkACopy = genCopyCompareFunc(top);
      var copyTasks = _.map(copies, checkACopy);
      async.parallel(copyTasks, next);
    };
    var expanded = [
      'objc/packager-unittest-v2.podspec'
    ];
    var compareWithFixture = genFixtureCompareFunc(top);
    var checkExpanded = function checkExpanded(next) {
      var expandTasks = _.map(expanded, compareWithFixture);
      async.parallel(expandTasks, next);
    };
    async.series([
      packager.objc.bind(null, opts),
      checkCopies,
      checkExpanded
    ], done);
  });
});

describe('the python package builder', function() {
  var top;
  beforeEach(function() {
    top = tmp.dirSync().name;
  });
  it('should construct a python package', function(done) {
    var opts = _.merge({
      packageInfo: testPackageInfo,
      top: path.join(top, 'python')
    }, templateDirs.python);
    var copies = [
      'python/PUBLISHING.rst',
      'python/MANIFEST.in'
    ];
    var checkCopies = function checkCopies(next) {
      var checkACopy = genCopyCompareFunc(top);
      var copyTasks = _.map(copies, checkACopy);
      async.parallel(copyTasks, next);
    };
    var expanded = [
      'python/README.rst',
      'python/setup.py'
    ];
    var compareWithFixture = genFixtureCompareFunc(top);
    var checkExpanded = function checkExpanded(next) {
      var expandTasks = _.map(expanded, compareWithFixture);
      async.parallel(expandTasks, next);
    };
    fs.mkdirpSync(path.join(top, 'python', 'pkgTop', 'pkgNext'));
    var checkPkgDirs = function checkPkgDir(next) {
      var topPkgFile = path.join('python', 'pkgTop', '__init__.py');
      var nextPkgFile = path.join('python', 'pkgTop', 'pkgNext', '__init__.py');
      async.parallel([
        compareWithFixture(topPkgFile),
        compareWithFixture(nextPkgFile)
      ], next);
    };

    async.series([
      packager.python.bind(null, opts),
      checkCopies,
      checkExpanded,
      checkPkgDirs
    ], done);
  });
});

describe('the ruby package builder', function() {
  var top;
  beforeEach(function() {
    top = tmp.dirSync().name;
  });

  it('should construct a ruby package', function(done) {
    var opts = _.merge({
      packageInfo: testPackageInfo,
      top: path.join(top, 'ruby')
    }, templateDirs.ruby);

    var copies = [
      'ruby/Gemfile',
      'ruby/PUBLISHING.md',
      'ruby/Rakefile'
    ];
    var checkCopies = function checkCopies(next) {
      var checkACopy = genCopyCompareFunc(top);
      var copyTasks = _.map(copies, checkACopy);
      async.parallel(copyTasks, next);
    };
    var expanded = [
      'ruby/packager-unittest-v2.gemspec'
    ];
    var compareWithFixture = genFixtureCompareFunc(top);
    var checkExpanded = function checkExpanded(next) {
      var expandTasks = _.map(expanded, compareWithFixture);
      async.parallel(expandTasks, next);
    };
    async.series([
      packager.ruby.bind(null, opts),
      checkCopies,
      checkExpanded
    ], done);
  });
});

describe('the nodejs package builder', function() {
  var top;
  beforeEach(function() {
    top = tmp.dirSync().name;
  });

  it('should construct a nodejs package', function(done) {
    var opts = _.merge({
      packageInfo: testPackageInfo,
      nodejsUsePbjs: true,
      top: path.join(top, 'nodejs')
    }, templateDirs.nodejs);
    var copies = [
      'nodejs/index.js',
      'nodejs/PUBLISHING.md'
    ];
    var checkCopies = function checkCopies(next) {
      var checkACopy = genCopyCompareFunc(top);
      var copyTasks = _.map(copies, checkACopy);
      async.parallel(copyTasks, next);
    };
    var expanded = [
      'nodejs/package.json',
      'nodejs/README.md'
    ];
    var compareWithFixture = genFixtureCompareFunc(top);
    var checkExpanded = function checkExpanded(next) {
      var expandTasks = _.map(expanded, compareWithFixture);
      async.parallel(expandTasks, next);
    };
    async.series([
      packager.nodejs.bind(null, opts),
      checkCopies,
      checkExpanded
    ], done);
  });

  it('should construct a proto-based nodejs package', function(done) {
    var opts = _.merge({
      packageInfo: testPackageInfo,
      nodejsUsePbjs: false,
      top: path.join(top, 'nodejs')
    }, templateDirs.nodejs);
    opts.packageInfo.nodejsUseProtos = true;
    opts.packageInfo.protoFiles = ['proto/foo.proto', 'proto/bar/baz.proto'];
    var copies = [
      'nodejs/index.js',
      'nodejs/PUBLISHING.md'
    ];
    var checkCopies = function checkCopies(next) {
      var checkACopy = genCopyCompareFunc(top);
      var copyTasks = _.map(copies, checkACopy);
      async.parallel(copyTasks, next);
    };
    var expanded = [
      'nodejs/package.json',
      'nodejs/service.js',
      'nodejs/README.md'
    ];
    var compareWithFixture = genFixtureCompareFunc(top, ['proto-based']);
    var checkExpanded = function checkExpanded(next) {
      var expandTasks = _.map(expanded, compareWithFixture);
      async.parallel(expandTasks, next);
    };
    async.series([
      packager.nodejs.bind(null, opts),
      checkCopies,
      checkExpanded
    ], done);
  });

  it('should construct a gax package', function(done) {
    var opts = _.merge({
      packageInfo: testPackageInfo,
      top: path.join(top, 'nodejs')
    }, {templateDir: path.join(__dirname, '..', 'templates', 'gax', 'nodejs')});
    opts.mockApiFilesForTest = ['foo_api.js', 'bar_api.js'];
    var expanded = [
      'nodejs/index.js'
    ];
    var compareWithFixture = genFixtureCompareFunc(top, ['gax']);
    var checkExpanded = function checkExpanded(next) {
      var expandTasks = _.map(expanded, compareWithFixture);
      async.parallel(expandTasks, next);
    };
    async.series([packager.nodejs.bind(null, opts), checkExpanded], done);
  });
});

describe('the java package builder', function() {
  var top;
  beforeEach(function() {
    top = tmp.dirSync().name;
  });

  it('should construct a java package', function(done) {
    var opts = _.merge({
      packageInfo: testPackageInfo,
      top: path.join(top, 'java')
    }, templateDirs.java);

    var copies = [
      'java/gradlew.bat',
      'java/gradlew'
    ];
    var checkCopies = function checkCopies(next) {
      var checkACopy = genCopyCompareFunc(top);
      var copyTasks = _.map(copies, checkACopy);
      async.parallel(copyTasks, next);
    };
    var expanded = [
      'java/build.gradle'
    ];
    var compareWithFixture = genFixtureCompareFunc(top);
    var checkExpanded = function checkExpanded(next) {
      var expandTasks = _.map(expanded, compareWithFixture);
      async.parallel(expandTasks, next);
    };
    async.series([
      packager.java.bind(null, opts),
      checkCopies,
      checkExpanded
    ], done);
  });
});

describe('the php package builder', function() {
  var top;
  beforeEach(function() {
    top = tmp.dirSync().name;
  });

  it('should construct a php package', function(done) {
    var opts = _.merge({
      packageInfo: testPackageInfo,
      top: path.join(top, 'php')
    }, templateDirs.php);

    var copies = [
      'php/PUBLISHING.md'
    ];
    var checkCopies = function checkCopies(next) {
      var checkACopy = genCopyCompareFunc(top);
      var copyTasks = _.map(copies, checkACopy);
      async.parallel(copyTasks, next);
    };
    var expanded = [
      'php/composer.json',
      'php/README.md'
    ];
    var compareWithFixture = genFixtureCompareFunc(top);
    var checkExpanded = function checkExpanded(next) {
      var expandTasks = _.map(expanded, compareWithFixture);
      async.parallel(expandTasks, next);
    };
    async.series([
      packager.php.bind(null, opts),
      checkCopies,
      checkExpanded
    ], done);
  });
});
