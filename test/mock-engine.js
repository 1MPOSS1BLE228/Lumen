'use strict';
// Поддельный «OpenRGB.exe --server --server-port N» для теста встроенного движка
const { startMock } = require('./mock-openrgb');
const i = process.argv.indexOf('--server-port');
const port = i > 0 ? Number(process.argv[i + 1]) : 6742;
if (!process.argv.includes('--server')) process.exit(3);
setTimeout(() => startMock({ port }), 600); // как настоящий: сервер поднимается не сразу
