'use strict';
// Виртуальные устройства для демо-режима: пока OpenRGB не подключён,
// в приложении видно, как будет выглядеть подсветка.

function keyboard() {
  const W = 18.25, H = 6.5;
  const keys = [];
  const add = (cx, row, w = 1) => keys.push({ cx, row, w });
  const rowY = [0, 1.5, 2.5, 3.5, 4.5, 5.5];

  // ряд 0
  add(0.5, 0);
  [2, 3, 4, 5].forEach((x) => add(x + 0.5, 0));
  [6.5, 7.5, 8.5, 9.5].forEach((x) => add(x + 0.5, 0));
  [11, 12, 13, 14].forEach((x) => add(x + 0.5, 0));
  [15.75, 16.75, 17.75].forEach((x) => add(x, 0));
  // ряд 1
  for (let i = 0; i < 13; i++) add(i + 0.5, 1);
  add(14, 1, 2);
  [15.75, 16.75, 17.75].forEach((x) => add(x, 1));
  // ряд 2
  add(0.75, 2, 1.5);
  for (let i = 0; i < 12; i++) add(1.5 + i + 0.5, 2);
  add(14.25, 2, 1.5);
  [15.75, 16.75, 17.75].forEach((x) => add(x, 2));
  // ряд 3
  add(0.875, 3, 1.75);
  for (let i = 0; i < 11; i++) add(1.75 + i + 0.5, 3);
  add(13.875, 3, 2.25);
  // ряд 4
  add(1.125, 4, 2.25);
  for (let i = 0; i < 10; i++) add(2.25 + i + 0.5, 4);
  add(13.625, 4, 2.75);
  add(16.75, 4);
  // ряд 5
  let x = 0;
  [1.25, 1.25, 1.25, 6.25, 1.25, 1.25, 1.25, 1.25].forEach((w) => { add(x + w / 2, 5, w); x += w; });
  [15.75, 16.75, 17.75].forEach((cx) => add(cx, 5));

  const leds = keys.map((k) => ({
    x: k.cx / W,
    y: (rowY[k.row] + 0.5) / H,
    w: (k.w - 0.12) / W,
    h: 0.88 / H,
  }));
  return {
    id: 'demo:keyboard', name: 'Клавиатура', kind: 'keyboard', vendor: 'Демо', source: 'demo',
    leds, aspect: W / H, linear: false, plate: true,
  };
}

function strip() {
  const n = 36;
  const leds = [];
  for (let i = 0; i < n; i++) leds.push({ x: i / (n - 1), y: 0.5 });
  return { id: 'demo:strip', name: 'LED-лента', kind: 'strip', vendor: 'Демо', source: 'demo', leds, aspect: 6, linear: true };
}

function fans() {
  const leds = [];
  for (let f = 0; f < 3; f++) {
    const cx = (f + 0.5) / 3;
    for (let j = 0; j < 16; j++) {
      const a = (j / 16) * Math.PI * 2 - Math.PI / 2;
      leds.push({ x: cx + Math.cos(a) * 0.135, y: 0.5 + Math.sin(a) * 0.4 });
    }
  }
  return { id: 'demo:fans', name: 'Вентиляторы 3×16', kind: 'cooler', vendor: 'Демо', source: 'demo', leds, aspect: 3, linear: false };
}

function mouse() {
  const pts = [
    [0.5, 0.2], // колесо
    [0.5, 0.62], // логотип
    [0.14, 0.5], [0.86, 0.5],
    [0.24, 0.84], [0.76, 0.84],
  ];
  return {
    id: 'demo:mouse', name: 'Мышь', kind: 'mouse', vendor: 'Демо', source: 'demo',
    leds: pts.map(([x, y]) => ({ x, y })), aspect: 0.62, linear: false, plate: true,
  };
}

function ram() {
  const leds = [];
  for (const x of [0.3, 0.7]) for (let j = 0; j < 8; j++) leds.push({ x, y: 0.08 + (j / 7) * 0.84, w: 0.2, h: 0.085 });
  return { id: 'demo:ram', name: 'Оперативная память', kind: 'ram', vendor: 'Демо', source: 'demo', leds, aspect: 0.95, linear: false };
}

function createDemoDevices() {
  return [keyboard(), fans(), strip(), mouse(), ram()];
}

module.exports = { createDemoDevices };
