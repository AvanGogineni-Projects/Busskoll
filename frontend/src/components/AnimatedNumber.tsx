import { useEffect } from "react";
import { animate, useMotionValue, useTransform, motion, useReducedMotion } from "framer-motion";

// Smoothly counts to `value` whenever it changes (Elvarsel's counter). Tabular figures
// so the width never jitters mid-animation; jumps straight there under reduced motion.
export default function AnimatedNumber({ value, digits = 0 }: { value: number; digits?: number }) {
  const reduced = useReducedMotion();
  const mv = useMotionValue(value);
  const text = useTransform(mv, (v) =>
    v.toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits })
  );

  useEffect(() => {
    const controls = animate(mv, value, { duration: reduced ? 0 : 0.8, ease: [0.16, 1, 0.3, 1] });
    return controls.stop;
  }, [mv, value, reduced]);

  return <motion.span className="tabular">{text}</motion.span>;
}
