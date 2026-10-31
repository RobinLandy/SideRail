# Security

SideRail's whole claim is that nothing leaves your browser and nothing else in your
browser can read what it keeps. If you find a way to break that claim, please say so
privately first.

## Reporting

Use GitHub's private vulnerability reporting on this repository: the **Security** tab,
then **Report a vulnerability**. That opens a draft advisory only the maintainer can see.
Please do not open a public issue for anything that could expose another user's data
until a fix is available.

Include the SideRail version (Settings → About), the browser and its version, and the
steps. A page that demonstrates the problem is ideal.

## What counts

- A web page, or another extension, being able to read anything SideRail stores: spaces,
  rules, snapshots, the page-text index, hover-preview thumbnails.
- SideRail sending data anywhere, or being made to. The test suite fails the build on any
  network call in shipped code; a way around that is a vulnerability.
- Code from a page running with the extension's privileges.
- A rule or import that can hang or crash the panel or the service worker.

## What to expect

This is a personal project maintained in spare time. Reports are read and acknowledged
as soon as practical, a fix is released as a normal version with a changelog entry that
describes the actual cause, and you are credited there if you want to be. There is no
bounty.
