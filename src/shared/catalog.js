'use strict';
// Готовые темы. Тема = эффект + палитра + скорость + направление.

const THEMES = [
  { id: 'cyberpunk', name: 'Киберпанк', tagline: 'Неон под дождём', effect: 'wave', colors: ['#ff2bd6', '#7a2bff', '#00e5ff'], speed: 55, direction: 'right' },
  { id: 'sunset', name: 'Закат', tagline: 'Тёплый вечерний свет', effect: 'wave', colors: ['#ff5e3a', '#ff2e63', '#8e2de2'], speed: 30, direction: 'left' },
  { id: 'aurora', name: 'Аврора', tagline: 'Северное сияние', effect: 'aurora', colors: ['#00ff9d', '#00c2ff', '#7b2dff'], speed: 45, direction: 'right' },
  { id: 'ocean', name: 'Океан', tagline: 'Глубина и прибой', effect: 'wave', colors: ['#0034ff', '#00a2ff', '#00ffd5'], speed: 30, direction: 'right' },
  { id: 'lava', name: 'Лава', tagline: 'Пламя снизу вверх', effect: 'fire', colors: ['#b30000', '#ff3d00', '#ffb300'], speed: 60, direction: 'up' },
  { id: 'tokyo', name: 'Неон Токио', tagline: 'Вывески ночного города', effect: 'breathing', colors: ['#ff2d95', '#2d8cff', '#b84dff'], speed: 40, direction: 'right' },
  { id: 'rainbow', name: 'Радуга', tagline: 'Классика RGB', effect: 'rainbow', colors: ['#ff0000'], speed: 50, direction: 'right' },
  { id: 'ice', name: 'Лёд', tagline: 'Холодный белый и лазурь', effect: 'wave', colors: ['#eafcff', '#7fd6ff', '#2b7bff'], speed: 25, direction: 'right' },
  { id: 'matrix', name: 'Матрица', tagline: 'Зелёный код в темноте', effect: 'twinkle', colors: ['#00240a', '#00ff41', '#7dff9a'], speed: 70, direction: 'right' },
  { id: 'sakura', name: 'Сакура', tagline: 'Лепестки на ветру', effect: 'breathing', colors: ['#ffb7d5', '#ff6fa8', '#fff0f6'], speed: 25, direction: 'right' },
  { id: 'gold', name: 'Золотой час', tagline: 'Спокойное тёплое сияние', effect: 'gradient', colors: ['#ff9500', '#ffd36b', '#ff6a00'], speed: 20, direction: 'right' },
  { id: 'vampire', name: 'Вампир', tagline: 'Медленный алый пульс', effect: 'breathing', colors: ['#ff0020', '#6a000e'], speed: 30, direction: 'right' },
  { id: 'space', name: 'Космос', tagline: 'Звёзды в пустоте', effect: 'twinkle', colors: ['#06001f', '#6a4cff', '#00d0ff', '#ffffff'], speed: 35, direction: 'right' },
  { id: 'gamer', name: 'Геймер', tagline: 'Красная комета', effect: 'comet', colors: ['#ff1e1e', '#ff7a00'], speed: 70, direction: 'right' },
  { id: 'synthwave', name: 'Синтвейв', tagline: 'Круги по сетке заката', effect: 'ripple', colors: ['#ff3cac', '#784ba0', '#2b86c5'], speed: 45, direction: 'right' },
  { id: 'night', name: 'Ночник', tagline: 'Мягкий янтарный свет', effect: 'static', colors: ['#ff8a3d'], speed: 10, direction: 'right' },
  { id: 'cinema', name: 'Кинотеатр', tagline: 'Цвета с экрана, как Ambilight', effect: 'screen', colors: ['#ffffff'], speed: 50, direction: 'right' },
  { id: 'thermo', name: 'Термометр', tagline: 'Цвет по нагреву видеокарты', effect: 'temperature', colors: ['#0080ff', '#00ffb0', '#ffd000', '#ff2020'], speed: 40, direction: 'right' },
  { id: 'party', name: 'Вечеринка', tagline: 'Свет бьётся в такт музыке', effect: 'music', colors: ['#ff2bd6', '#00e5ff', '#ffe600'], speed: 50, direction: 'right' },
];

module.exports = { THEMES };
