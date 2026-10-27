# Для разработчиков

## Сборка

- Вручную: `npm install --no-save electron@45.0.0 electron-builder@26`, затем `npm test` и `npm run dist`.
- Выпуск: поменяй версию в `package.json`, допиши `CHANGELOG.md` и отправь в `main` — установщик соберёт, поставит метку `vX.Y.Z` и опубликует GitHub Actions (`.github/workflows/release.yml`).

Переводы — `src/shared/i18n/table.tsv` (колонки: русский, English, Українська, Deutsch, Español);
после правки: `python scripts/gen-i18n.py src/shared/i18n/table.tsv src/shared/i18n.js`.
