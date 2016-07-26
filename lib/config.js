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

var fs = require('fs');
var path = require('path');
var yaml = require('js-yaml');

var configPath = function configPath(base) {
  return path.join(__dirname, '..', 'config', base);
};

var loadYamlSync = function loadYamlSync(path) {
  return yaml.safeLoad(fs.readFileSync(path, 'utf8'));
};

var fallback = {
  apiDefaultsFile: configPath('api_defaults.yml'),
  depsFile: configPath('dependencies.yml'),
  commonPbFile: configPath('common_protos.yml'),
  pythonPkgFile: configPath('python_pkg.yml')
};

/**
 * Obtains an object containing the configured or default api/dependencies.
 * @param {?Object} opts The optional argument of dependencies.
 * @return {Object} The package info.
 */
exports.packageInfo = function packageInfo(opts) {
  opts = opts || {};
  var apiDefaultsFile = opts.apiDefaultsFile || fallback.apiDefaultsFile;
  var depsFile = opts.depsFile || fallback.depsFile;
  return {
    api: loadYamlSync(apiDefaultsFile),
    dependencies: loadYamlSync(depsFile)
  };
};

/**
 * Obtains an object containing information about the known common protobuf
 * definitions.
 * @param {?Object} opts The optional argument for common PB file.
 * @return {Object} The common PB info.
 */
exports.commonPb = function commonPb(opts) {
  opts = opts || {};
  var commonPbFile = opts.commonPbFile || fallback.commonPbFile;
  return loadYamlSync(commonPbFile);
};

/**
 * Obtains an object configuring information about the known python packages
 * @param {?Object} opts The optional argument for python package data.
 * @return {Object} The python package info.
 */
exports.pythonPkg = function pythonPkg(opts) {
  opts = opts || {};
  var pythonPkgFile = opts.pythonPkgFile || fallback.pythonPkgFile;
  return loadYamlSync(pythonPkgFile);
};
