export function createRobotMarkerElement(color, labelText) {
  const root = document.createElement('div');
  root.className = 'robot-marker-root';
  root.setAttribute('aria-hidden', 'true');
  root.style.position = 'relative';

  const car = document.createElement('div');
  car.className = 'robot-car';
  car.style.width = '100%';
  car.style.height = '100%';
  car.style.display = 'flex';
  car.style.alignItems = 'center';
  car.style.justifyContent = 'center';
  car.style.position = 'relative';
  car.style.zIndex = '2';

  car.innerHTML = `
    <svg width="26" height="26" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M14 36L18 22C19 18 22 16 26 16H38C42 16 45 18 46 22L50 36" stroke="${color}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M16 36H48" stroke="${color}" stroke-width="6" stroke-linecap="round"/>
      <path d="M20 44H18C15 44 13 42 13 39V36H21V44Z" fill="${color}"/>
      <path d="M44 44H46C49 44 51 42 51 39V36H43V44Z" fill="${color}"/>
      <circle cx="22" cy="44" r="4" fill="#0f172a"/>
      <circle cx="42" cy="44" r="4" fill="#0f172a"/>
      <path d="M24 26H40" stroke="${color}" stroke-width="5" stroke-linecap="round"/>
    </svg>
  `;

  const label = document.createElement('div');
  label.className = 'robot-label';
  label.textContent = labelText;
  label.style.position = 'absolute';
  label.style.left = '50%';
  label.style.bottom = '100%';
  label.style.transform = 'translate(-50%, -6px)';
  label.style.background = '#000';
  label.style.color = '#fff';
  label.style.padding = '2px 6px';
  label.style.borderRadius = '4px';
  label.style.fontSize = '10px';
  label.style.fontWeight = '700';
  label.style.letterSpacing = '0.06em';
  label.style.whiteSpace = 'nowrap';
  label.style.pointerEvents = 'none';
  label.style.zIndex = '1';
  label.style.opacity = '0.95';

  root.appendChild(car);
  root.appendChild(label);
  return { root, car, label };
}
