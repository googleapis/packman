"""A setup module for the GRPC packager service.

See:
https://packaging.python.org/en/latest/distributing.html
https://github.com/pypa/sampleproject
"""

import setuptools

from setuptools import setup, find_packages

install_requires = [
  'oauth2client>=0.4.1',
  'grpcio>=0.9.0a0',
  'googleapis-common-protos>=3.0.0b1.1'
]

setuptools.setup(
  name='packager-unittest-v2',
  version='1.0.0',

  author='Google Inc',
  author_email='googleapis-packages@google.com',
  classifiers=[
    'Intended Audience :: Developers',
    'Development Status :: 3 - Alpha',
    'Intended Audience :: Developers',
    'License :: OSI Approved :: Apache Software License',
    'Programming Language :: Python',
    'Programming Language :: Python :: 2.7',
    'Programming Language :: Python :: Implementation :: CPython',
  ],
  description='GRPC library for the packager-v2 service',
  long_description=open('README.rst').read(),
  install_requires=install_requires,
  license='BSD-3-Clause',
  packages=find_packages(),
  namespace_packages=['pkgTop', 'pkgTop.pkgNext', ],
  url='https://github.com/google/googleapis'
)
