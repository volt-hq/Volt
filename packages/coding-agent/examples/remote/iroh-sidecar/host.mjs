console.error(
	'The standalone Iroh remote host was replaced by the background daemon. Run "volt daemon start" (or enable remote.background). See docs/daemon.md.',
);
process.exitCode = 1;
