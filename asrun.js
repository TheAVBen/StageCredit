// As-run log.
//
// Written from the MAIN process, appended line by line as events happen, so the log
// survives a renderer crash or a force-quit mid-show — which is exactly when you most
// want to know what actually went out.
//
// JSON Lines rather than CSV on disk: appending is a single write with no need to
// re-read or re-quote earlier rows, and a half-written final line can be discarded
// without corrupting the rest. CSV is generated on export.

const fs = require('fs');

class AsRun {
  constructor(file) {
    this.file = file;
  }

  append(entry) {
    if (!entry || !entry.event) return;
    const line = JSON.stringify(Object.assign({ at: new Date().toISOString() }, entry));
    try {
      fs.appendFileSync(this.file, line + '\n', 'utf8');
    } catch (e) {
      // Never let logging take the show down.
    }
  }

  readAll() {
    let raw;
    try { raw = fs.readFileSync(this.file, 'utf8'); }
    catch (e) { return []; }
    return raw.split('\n').reduce((acc, l) => {
      if (!l.trim()) return acc;
      // A truncated last line from an abrupt exit is skipped, not fatal.
      try { acc.push(JSON.parse(l)); } catch (e) {}
      return acc;
    }, []);
  }

  clear() {
    try { fs.writeFileSync(this.file, '', 'utf8'); } catch (e) {}
  }
}

module.exports = AsRun;
