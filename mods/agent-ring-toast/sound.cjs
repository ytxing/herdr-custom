const { existsSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const [kind, mode = 'random', address = '', fixed = ''] = process.argv.slice(2);
const defaults = { done: 'whatthedogdoin.mp3', suspended: 'error.mp3' };
if (!Object.hasOwn(defaults, kind)) process.exit(2);
const directory = join(__dirname, 'sound-fx', kind);
const files = existsSync(directory) ? readdirSync(directory).filter(file => file.endsWith('.mp3')).sort() : [];
if (mode === 'list') {
  console.log(JSON.stringify(files));
} else if (!files.length) {
  execFileSync('/usr/bin/afplay', [`/System/Library/Sounds/${kind === 'done' ? 'Glass' : 'Basso'}.aiff`]);
} else {
  const index = address ? createHash('sha256').update(address).digest().readUInt32BE() % files.length
    : Math.floor(Math.random() * files.length);
  const track = mode === 'fixed' ? (files.includes(fixed) ? fixed : files.includes(defaults[kind]) ? defaults[kind] : files[0]) : files[index];
  execFileSync('/usr/bin/afplay', [join(directory, track)]);
}
