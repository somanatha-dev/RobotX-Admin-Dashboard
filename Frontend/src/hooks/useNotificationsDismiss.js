import { useEffect } from 'react';

export default function useNotificationsDismiss({
  isOpen,
  setIsOpen,
  popupRef,
  buttonRef,
}) {
  useEffect(() => {
    if (!isOpen) return;

    const onKeyDown = (e) => {
      if (e.key === 'Escape') setIsOpen(false);
    };

    const onPointerDown = (e) => {
      const popupEl = popupRef.current;
      const buttonEl = buttonRef.current;
      const target = e.target;

      if (popupEl && popupEl.contains(target)) return;
      if (buttonEl && buttonEl.contains(target)) return;
      setIsOpen(false);
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [isOpen, setIsOpen, popupRef, buttonRef]);
}
