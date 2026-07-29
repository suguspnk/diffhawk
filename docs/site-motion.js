import { animate } from './vendor/motion-mini-12.43.0.js';

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const activeAnimations = new Set();
let revealObserver;

function track(animation) {
  activeAnimations.add(animation);
  animation.finished.then(
    () => activeAnimations.delete(animation),
    () => activeAnimations.delete(animation),
  );
  return animation;
}

function animateHero() {
  const heroItems = document.querySelectorAll('[data-motion-hero-item]');
  const terminal = document.querySelector('[data-motion-terminal]');

  if (heroItems.length > 0) {
    track(animate(
      heroItems,
      {
        opacity: [0, 1],
        transform: ['translateY(8px)', 'translateY(0)'],
      },
      {
        duration: 0.3,
        delay: (index) => index * 0.04,
        ease: [0.16, 1, 0.3, 1],
      },
    ));
  }

  if (terminal) {
    track(animate(
      terminal,
      {
        opacity: [0, 1],
        transform: ['translateY(12px)', 'translateY(0)'],
      },
      {
        duration: 0.38,
        delay: 0.12,
        ease: [0.16, 1, 0.3, 1],
      },
    ));
  }
}

function revealElements(target) {
  const mode = target.dataset.motionReveal;
  const elements = mode === 'rise'
    ? [target]
    : [...target.children];
  const keyframes = mode === 'stagger-fade'
    ? { opacity: [0, 1] }
    : {
        opacity: [0, 1],
        transform: ['translateY(12px)', 'translateY(0)'],
      };

  track(animate(
    elements,
    keyframes,
    {
      duration: mode === 'rise' ? 0.35 : 0.3,
      delay: mode.startsWith('stagger')
        ? (index) => index * 0.04
        : 0,
      ease: [0.16, 1, 0.3, 1],
    },
  ));
}

function observeReveals() {
  if (!('IntersectionObserver' in window)) {
    return;
  }

  revealObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) {
          continue;
        }

        revealObserver.unobserve(entry.target);
        revealElements(entry.target);
      }
    },
    {
      threshold: 0.18,
      rootMargin: '0px 0px -8% 0px',
    },
  );

  for (const target of document.querySelectorAll('[data-motion-reveal]')) {
    revealObserver.observe(target);
  }
}

function showAllMotionTargets() {
  const targets = document.querySelectorAll(
    '[data-motion-hero-item], [data-motion-terminal], [data-motion-reveal], ' +
    '[data-motion-reveal] > *',
  );

  for (const target of targets) {
    target.style.opacity = '1';
    target.style.transform = 'none';
  }
}

function stopMotion() {
  revealObserver?.disconnect();
  for (const animation of activeAnimations) {
    animation.stop();
  }
  activeAnimations.clear();
  showAllMotionTargets();
}

if (!reducedMotion.matches) {
  animateHero();
  observeReveals();
}

const handleMotionPreference = (event) => {
  if (event.matches) {
    stopMotion();
  }
};

if ('addEventListener' in reducedMotion) {
  reducedMotion.addEventListener('change', handleMotionPreference);
} else {
  reducedMotion.addListener(handleMotionPreference);
}
