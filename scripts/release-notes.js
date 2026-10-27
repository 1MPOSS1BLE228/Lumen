// Описание выпуска для GitHub: раздел текущей версии из CHANGELOG.md + памятка про установку.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const ver = require(path.join(root, 'package.json')).version;
const log = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const m = new RegExp(`^## ${ver.replace(/\./g, '\\.')}\\b[^\\n]*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm').exec(log);
const notes = m ? m[1].trim() : 'Исправления и улучшения.';
process.stdout.write(`## Что нового в Lumen ${ver}

${notes}

---
**Как установить:** скачай \`Lumen-Setup-${ver}.exe\` ниже и запусти. Если Windows пишет «Интеллектуальное управление приложениями заблокировало приложение», смотри [гайд](https://github.com/1MPOSS1BLE228/Lumen/blob/main/docs/install-guide.pdf).
Уже установлен Lumen? Он обновится сам (Настройки → Обновления).
`);
