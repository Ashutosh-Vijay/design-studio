// Copies what the .vsix ships besides the code into resources/: the AMF engine jar, the jlinked JRE for this
// platform (built for the desktop app, src-tauri/resources/jre), and the sign-in client list.
// Run after `mvn package` in amf-server and the JRE step (release.yml does both).
import { cpSync, mkdirSync, existsSync, rmSync } from 'node:fs';
const from = (p) => new URL(`../../${p}`, import.meta.url), to = (p) => new URL(`../resources/${p}`, import.meta.url);
rmSync(to(''), { recursive: true, force: true });
mkdirSync(to('amf-server'), { recursive: true });
cpSync(from('amf-server/target/amf-server.jar'), to('amf-server/amf-server.jar'));
if (existsSync(from('src-tauri/resources/jre/bin'))) cpSync(from('src-tauri/resources/jre'), to('jre'), { recursive: true });
else console.warn('No jlinked JRE in src-tauri/resources/jre: the extension will need Java 17+ on the machine.');
cpSync(from('src-tauri/clients.json'), to('clients.json'));
console.log('resources ready');
