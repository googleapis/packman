# googleapis-packman

Provides `gen-api-package`, a tool that generates packages in different
programming languages from services defined in protocol buffer IDL.


## Examples

Generate the python package for protos in a local directory.  The directory
defines protobuf services in a layout similar to that of
[googleapis](https://github.com/google/googleapis)


```
gen-api-package --api_name=my_new_service/v1 -l python -r my_protobuf_dir/my_new_service/v1
```

Generate the python package for Google's logging/v2 API, where logging/v2 is
service defined in [googleapis](https://github.com/google/googleapis).


```
gen-api-package --api_name=logging/v2 -l python
```


Generate the java package for Google's logging/v2 API, where logging/v2 is
service defined in [googleapis](https://github.com/google/googleapis). The package

- only contains the .proto files - there is no java source code
- takes a dependency on [grpc-gradle-plugin](https://github.com/google/protobuf-gradle-plugin) to generate the protobuf and gRPC source when the package is built.


```
gen-api-package --api_name=logging/v2 -l java
```

Generate the ruby package for Google's pubsub/v1 API, where pubsub/v1 is
service defined in [googleapis](https://github.com/google/googleapis).


```sh
gen-api-package --api_name=pubsub/v1 -l ruby
```


# Installation

```sh
npm install -g googleapis-packman
```

# CLI Usage
```
usage: gen-api-package [-h] [-v] [-x] [-i INCLUDEPATH] [-o OUTDIR]
                       [-n APINAME] [-l [LANGUAGES [LANGUAGES ...]]]
                       [-r REPODIR] [-u ZIPURL]
                       [--api_defaults_file APIDEFAULTSFILE]
                       [--dependencies_file DEPSFILE]
                       [--common_protos_file COMMONPBFILE]
                       [--package_prefix PKGPREFIX]
                       [--template_root TEMPLATEROOT]
                       [--override_plugins OVERRIDEPLUGINS]
                       [--proto_compiler PROTOCOMPILER]
                       [--proto_compiler_args PROTOCOMPILERARGS]


Creates packages for gRPC services.

Optional arguments:
  -h, --help            Show this help message and exit.
  -v, --version         Show program's version number and exit.
  -x, --build_common_protos
                        Build a package containing the common google API
                        protobufs. The value of --api_name will be ignored.
  -i INCLUDEPATH, --include_path INCLUDEPATH
                        Include path for additional protos. This is a
                        PATH-like value used to locate shared proto
                        defintions outside of an apis directory, but within
                        services_root or repository.
  -o OUTDIR, --out_dir OUTDIR
                        The directory in which the generated packages will be
                        saved.
  -n APINAME, --api_name APINAME
                        Name of the api to generate. The name should include
                        the version component; e.g. use "pubsub/v1" to
                        specify the protos in pubsub/v1 sub-directory of the
                        services_root.
  -l [LANGUAGES [LANGUAGES ...]], --languages [LANGUAGES [LANGUAGES ...]]
                        Specifies the language for which packages should be
                        generated.
  -r REPODIR, --services_root REPODIR
                        The directory containing the rpc service proto
                        definitions. Can be specified multiple times. Should
                        not be specified with -u/--zip_url, which clobbers this.
  -u ZIPURL, --zip_url ZIPURL
                        URL of a git repository containing the rpc proto
                        definitions. Should not be specified with
                        -r/--services_root, which will be ignored.
  --api_defaults_file APIDEFAULTSFILE
                        Specifies an alternate location for the api_defaults
                        config file. api_defaults.yml configures shared
                        package metadata to be used in packages of any
                        language.
  --dependencies_file DEPSFILE
                        Specifies an alternate location for the deps config
                        file. dependencies.yml configures the per-language
                        dependencies that each language package relies on.
  --common_protos_file COMMONPBFILE
                        Specifies an alternate location for the common protos
                        config file. common_protos.yml configures the paths
                        to include when generating the packages that contain
                        common protos.
  --package_prefix PKGPREFIX
                        Prefix to use when constructing package names if
                        is_google_api is set, this defaults to "grpc-google-"
                        otherwise the default is "".
  --template_root TEMPLATEROOT
                        The root dir for the package templates. Allows
                        alternate templates to be used during package
                        generation. The template root must contain the same
                        files for any specified languages as in the builtin
                        template root.
  --override_plugins OVERRIDEPLUGINS
                        Specifies the override protoc plugins to be used. E.g
                        by default the plugin for python is named
                        grpc_python_plugin. This can be modified by
                        specifying --override_plugins
                        python=other_rpc_python_plugin.
  --proto_compiler PROTOCOMPILER
                       Specifies the proto compiler to be used, if not protoc
                       Defaults to protoc.
  --proto_compiler_args PROTOCOMPILERARGS
                       Specifies arguments that always should be passed to the
                       proto compiler
```
