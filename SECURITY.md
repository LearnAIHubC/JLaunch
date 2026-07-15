# Security policy

## Supported versions

Security fixes are applied to the latest published JLaunch release.

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/LearnAIHubC/JLaunch/security/advisories/new). Include:

- affected JLaunch version and operating system;
- a minimal reproduction;
- expected impact;
- whether the issue exposes local files, credentials, processes, or debug ports.

Do not include real credentials or proprietary source code. Please allow maintainers time to investigate before public disclosure.

## Local data

JLaunch stores project configuration and environment variables in a local SQLite file. Values are not encrypted. Prefer operating-system environment injection or a dedicated secret manager for long-lived secrets.

JLaunch does not run a backend service or upload project source and logs. Debug ports are bound to loopback, but any local process may still attempt to connect; use unique ports and stop Debug sessions when they are no longer needed.
