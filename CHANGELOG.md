# Changelog

All notable changes to JLaunch are documented here. This project follows [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-07-15

### Added

- Automatic Spring Boot application discovery across Maven multi-module projects.
- Direct Java Run and Debug commands with reactor-aware Maven classpaths.
- Spring Boot executable JAR and managed Tomcat launch modes.
- JDK, Maven, and Tomcat discovery with per-project overrides.
- Repository grouping and ordered repository startup.
- Maven module tree, Profiles, Lifecycle execution, cancellation, and logs.
- JDWP + `jdb` breakpoint workflow with source tree, pause location, and resume.
- Editable `$MODULE_WORKING_DIR$`, program arguments, environment variables, and startup order.
- Bounded 2,000-line project/Maven consoles with text and regular-expression filters.
- Resizable source tree and horizontal/vertical source scrolling.
- SQLite persistence, process-tree cleanup, sandboxed renderer, and disabled DevTools.
- Custom dark title bar and JLaunch visual identity for macOS and Windows.

[1.0.0]: https://github.com/LearnAIHubC/JLaunch/releases/tag/v1.0.0
