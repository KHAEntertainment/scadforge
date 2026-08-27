// Fixture: attempts to import an absolute host path. Containment test --
// this resolves inside the CONTAINER's filesystem (bind-mounted /work only),
// never the host's. Expected to fail cleanly (RENDER_FAILED), never crash
// the runner or leak host file contents.
import("/etc/passwd");
