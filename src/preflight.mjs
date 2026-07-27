// Imported first by the CLI so an unsupported runtime fails with a readable
// message instead of a stack trace from deep inside the database layer.
//
// node:sqlite landed in 22.5.0 but sat behind --experimental-sqlite until
// 22.13.0 on the v22 line and 23.4.0 on the v23 line, so those earlier
// versions import the module name successfully only when the flag is passed.
const [maj, min] = process.versions.node.split('.').map(Number);

const supported =
  maj >= 24 ||
  (maj === 23 && min >= 4) ||
  (maj === 22 && min >= 13);

if (!supported) {
  console.error(`poppin needs Node 22.13+, 23.4+, or 24+. You are on ${process.versions.node}.`);
  console.error('Earlier versions keep node:sqlite behind the --experimental-sqlite flag.');
  process.exit(1);
}

try {
  await import('node:sqlite');
} catch (e) {
  console.error(`poppin could not load node:sqlite on Node ${process.versions.node}.`);
  console.error(e.message);
  process.exit(1);
}
