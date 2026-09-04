# Security policy

OpenDartboard Match Console is intended for trusted local networks. Do not expose its web port, scorer API, camera streams, or host-control socket to the public internet.

Please report security problems privately to the repository owner rather than opening a public issue. Do not include passwords, access tokens, private camera frames, or full diagnostic bundles in a report.

The host helper must remain narrowly scoped: no arbitrary shell command, service name, image name, path, environment value, or hostname may come from a browser request.
