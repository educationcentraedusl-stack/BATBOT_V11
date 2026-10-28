const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// 1. Sanitize PATH to remove any rogue quotation marks that corrupt cmd.exe path lookup on Windows
if (process.env.PATH) {
  process.env.PATH = process.env.PATH.replace(/"/g, '');
}

// 2. Ensure Cargo bin directory is deterministically present in PATH
const cargoBin = process.env.CARGO_HOME
  ? path.join(process.env.CARGO_HOME, 'bin')
  : (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.cargo', 'bin') : null);

if (cargoBin && fs.existsSync(cargoBin)) {
  const delimiter = path.delimiter; // ';' on Windows, ':' on POSIX
  const paths = (process.env.PATH || '').split(delimiter);
  if (!paths.includes(cargoBin)) {
    process.env.PATH = `${cargoBin}${delimiter}${process.env.PATH}`;
  }
}

// 3. Execute napi build cleanly
try {
  execSync('napi build --platform --release', {
    stdio: 'inherit',
    env: process.env
  });
} catch (error) {
  process.exit(error.status || 1);
}
