#!/bin/sh
# Regenerates the synthetic certificates used by the worker tests.
# Each is a throwaway self-signed certificate whose SAN list holds test domains.
# Run from this directory: sh make-synthetic.sh
set -eu
mkdir -p synthetic
make_cert() { # name, subject CN, SAN list
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout /dev/null \
    -subj "/O=Phishwatch Test CA/CN=$2" -addext "subjectAltName=$3" -days 90 \
    -outform DER -out "synthetic/$1.der" 2>/dev/null
}
# A: an official domain, its www, and one lookalike
make_cert a acmecu-login.top "DNS:acmecu-login.top,DNS:acmecu.org,DNS:www.acmecu.org"
# B: logged as a precertificate in the synthetic tile
make_cert b acrnecu.com "DNS:acrnecu.com,DNS:acmecu.org.verify-acct.top,DNS:prometall.ru"
# C: wildcard, glued, bait-heavy, punycode (Cyrillic a), and AWS noise
make_cert c acmecu-pay.xyz "DNS:*.acmecu-pay.xyz,DNS:myacmecu.net,DNS:acmecu-secure-login-verify.top,DNS:xn--cmecu-3ve.com,DNS:acmecu.acm.aws.dev"
# D: harmless filler that pads the synthetic tile to 256 entries
make_cert d benign-filler.example "DNS:benign-filler.example,DNS:www.benign-filler.example"
ls -l synthetic
