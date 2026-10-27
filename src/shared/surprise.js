'use strict';
// «Удиви меня»: случайная, но гармоничная тема — цвета по правилам цветового круга.

const EFFECTS_POOL = ['wave', 'aurora', 'breathing', 'cycle', 'comet', 'ripple', 'twinkle', 'gradient'];
const ADJ = ['Неоновый', 'Тихий', 'Звёздный', 'Летний', 'Северный', 'Ночной', 'Дикий', 'Мятный', 'Сонный', 'Космический', 'Тёплый', 'Ледяной'];
const NOUN = ['рассвет', 'прибой', 'туман', 'вихрь', 'сон', 'город', 'лес', 'берег', 'дождь', 'шторм', 'закат', 'огонь'];

function hsvHex(h, s, v) {
  h = ((h % 1) + 1) % 1;
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
  return '#' + [r, g, b].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}

// rand — для тестов можно подставить свой генератор
function randomTheme(rand = Math.random) {
  const pick = (arr) => arr[Math.floor(rand() * arr.length) % arr.length];
  const base = rand();
  const schemes = {
    analog: [0, 0.07, 0.14],
    complement: [0, 0.5, 0.04],
    triad: [0, 0.333, 0.667],
    split: [0, 0.42, 0.58],
    duo: [0, 0.12],
  };
  const schemeName = pick(Object.keys(schemes));
  const offs = schemes[schemeName];
  const colors = offs.map((o, i) => hsvHex(base + o, 0.75 + rand() * 0.25, i === 0 ? 1 : 0.8 + rand() * 0.2));
  const effect = pick(EFFECTS_POOL);
  return {
    name: `${pick(ADJ)} ${pick(NOUN)}`,
    effect,
    colors,
    speed: 25 + Math.round(rand() * 45),
    direction: pick(['right', 'left', 'up', 'down']),
    scheme: schemeName,
  };
}

module.exports = { randomTheme, hsvHex };
