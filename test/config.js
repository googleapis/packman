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

var chai = require('chai');
chai.use(require('dirty-chai'));
var config = require('../lib/config');
var expect = chai.expect;
var fs = require('fs-extra');
var path = require('path');
var tmp = require('tmp');

function addFakeConfigFile(name, someYaml) {
  var tmpObj = tmp.dirSync();
  var configFile = path.join(tmpObj.name, name);
  fs.writeFileSync(configFile, someYaml);
  return configFile;
}

var fakeYaml = "what:\n" +
    "  - is\n" +
    "  - this\n";

describe('method `packageInfo`', function() {
  it('has a value by default', function() {
    expect(config.packageInfo()).to.be.ok();
  });

  it('can load values via a config file', function() {
    var opts = {
      depsFile: addFakeConfigFile('deps', fakeYaml),
      apiDefaultsFile: addFakeConfigFile('apiDefaults', fakeYaml)
    };
    expect(config.packageInfo(opts)).to.be.ok();
    expect(config.packageInfo(opts).api.what).to.eql(['is', 'this']);
    expect(config.packageInfo(opts).dependencies.what).to.eql(['is', 'this']);
  });
});

describe('method `commonPb`', function() {
  it('has a value by default', function() {
    expect(config.commonPb()).to.be.ok();
  });

  it('can load values via a config file', function() {
    var opts = {
      commonPbFile: addFakeConfigFile('commonPb', fakeYaml)
    };
    expect(config.commonPb(opts)).to.be.ok();
    expect(config.commonPb(opts).what).to.eql(['is', 'this']);
  });
});

describe('method `pythonPkg`', function() {
  it('has a value by default', function() {
    expect(config.pythonPkg()).to.be.ok();
  });

  it('can load values via a config file', function() {
    var opts = {
      pythonPkgFile: addFakeConfigFile('pythonPkg', fakeYaml)
    };
    expect(config.pythonPkg(opts)).to.be.ok();
    expect(config.pythonPkg(opts).what).to.eql(['is', 'this']);
  });
});
