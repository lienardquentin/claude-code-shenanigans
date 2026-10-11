# vendor

mermaid.min.js is the Mermaid library (https://github.com/mermaid-js/mermaid), version **11.4.0**, MIT licensed
(LICENSE-mermaid). The browser page the mod writes loads this copy from the temporary folder, so that drawing a
diagram in the browser needs no network and contacts no site.

- Taken from the npm tarball https://registry.npmjs.org/mermaid/-/mermaid-11.4.0.tgz (package/dist/mermaid.min.js),
  after checking the tarball against the registry's own integrity value
  sha512-mxCfEYvADJqOiHfGpJXLs4/fAjHz448rH0pfY5fAoxiz70rQiDSzUUy4dNET2T08i46IVpjohPd6WWbzmRHiPA==.
- SHA-256 of mermaid.min.js: $sha
- It was searched for network use before being added: no XMLHttpRequest, WebSocket, sendBeacon or CDN
  address; the etch( calls in it are KaTeX's token reader. The hosts it names are XML namespaces and links in
  comments and licenses.

To update it: take the new version's tarball, check its integrity the same way, replace the file, and change the
version and hashes here.