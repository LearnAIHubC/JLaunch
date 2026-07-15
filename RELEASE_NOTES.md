# JLaunch v1.0.0

The first public release of JLaunch: a lightweight desktop launchpad for Spring Boot, Maven multi-module applications, and Tomcat.

## Highlights

- Add one Maven root and automatically discover every runnable Spring Boot Application.
- Run and Debug with the selected JDK's `java` executable—no long-running `spring-boot:run` process.
- Resolve an IDEA-style classpath, including reactor classes and provided dependencies required by WAR/JSP applications.
- Set real Java breakpoints through JDWP and the selected JDK's `jdb`.
- Manage multiple JDK, Maven, and Tomcat installations.
- Execute Maven Lifecycle goals from a dedicated tool window.
- Keep memory bounded with 2,000-line consoles and live text/RegExp filters.
- Store configuration locally in SQLite; no backend or account required.

## Downloads

- macOS Apple Silicon: ARM64 DMG or ZIP
- macOS Intel: x64 DMG or ZIP
- Windows x64: NSIS installer or portable EXE
- `SHA256SUMS.txt`: checksums for every release asset

Public packages are currently unsigned. macOS users may need to right-click the app and choose **Open**. Windows may display a SmartScreen warning.
