# azalea-bridge

Sidecar that drives an [Azalea](https://github.com/azalea-rs/azalea) Minecraft
client over JSON-lines stdin/stdout. The Node app (`bots/azalea.js`)
spawns this binary for the default **Azalea** bot engine.

Azalea only speaks the **latest vanilla protocol** (currently Minecraft 26.1).
Servers running ViaVersion (most modern networks) accept it. 1.8-only servers
will not.

This is a real client library, not an anticheat bypass. Competitive PvP
networks can still ban automated accounts.

## Build

Requires Rust **nightly**:

```sh
rustup toolchain install nightly
cd azalea-bridge
cargo +nightly build --release
```

The Docker image compiles this automatically and installs the binary at
`/usr/local/bin/azalea-bridge`. First compile takes 10–20 minutes.
