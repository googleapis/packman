# -*- ruby -*-
# encoding: utf-8

Gem::Specification.new do |s|
  s.name          = 'packager-unittest'
  s.version       = '1.0.0'

  s.authors       = ['Google Inc']
  s.description   = 'a unittest api'
  s.email         = 'googleapis-packages@google.com'
  s.files         = Dir.glob(File.join('lib', '**', '*.rb'))
  s.homepage      = 'https://github.com/google/googleapis'
  s.license       = 'BSD-3-Clause'
  s.platform      = Gem::Platform::RUBY
  s.require_paths = ['lib']
  s.required_ruby_version = '>= 2.0.0'
  s.requirements << 'libgrpc ~> 0.9.0 needs to be installed'
  s.summary       = 'GRPC library for service packager-unittest'

  s.add_dependency 'grpc', '~> 0.9.3'
  s.add_dependency 'googleauth', '~> 0.4.1'
  s.add_dependency 'googleapis-common-protos', '~> 3.0.0b1.1'

  s.add_development_dependency 'bundler', '~> 1.9'
  s.add_development_dependency 'rake', '~> 10.4'
end
