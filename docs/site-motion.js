import { animate } from './vendor/motion-mini-12.43.0.js';

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const activeAnimations = new Set();
const motion = Object.freeze({
  easeOut: [0.25, 0.46, 0.45, 0.94],
  heroDuration: 0.95,
  heroStagger: 0.14,
  terminalDuration: 1.1,
  terminalDelay: 0.28,
  revealDuration: 0.85,
  riseDuration: 0.95,
  revealStagger: 0.12,
});
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
        transform: ['translateY(12px)', 'translateY(0)'],
      },
      {
        duration: motion.heroDuration,
        delay: (index) => index * motion.heroStagger,
        ease: motion.easeOut,
      },
    ));
  }

  if (terminal) {
    track(animate(
      terminal,
      {
        opacity: [0, 1],
        transform: ['translateY(16px)', 'translateY(0)'],
      },
      {
        duration: motion.terminalDuration,
        delay: motion.terminalDelay,
        ease: motion.easeOut,
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
      duration: mode === 'rise'
        ? motion.riseDuration
        : motion.revealDuration,
      delay: mode.startsWith('stagger')
        ? (index) => index * motion.revealStagger
        : 0,
      ease: motion.easeOut,
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
      threshold: 0.12,
      rootMargin: '0px 0px -4% 0px',
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
