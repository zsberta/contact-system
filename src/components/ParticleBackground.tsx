"use client";

import React, { useEffect, useRef } from "react";

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  opacity: number;
}

import { getSecureRandomValues } from "@/utils/crypto";

const ParticleBackground: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const animationRef = useRef<number>();
  // Default fallback to primary color HSL values (light theme)
  const primaryColorRef = useRef<{ h: string; s: string; l: string }>({
    h: "160",
    s: "100%",
    l: "37%",
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const resizeCanvas = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };

    // Function to read the current --primary HSL value from CSS
    const getPrimaryColor = () => {
      const style = getComputedStyle(document.documentElement);
      // Reads the space-separated HSL string (e.g., "160 100% 37%")
      const primaryHsl = style.getPropertyValue("--primary").trim();
      if (primaryHsl) {
        const [h, s, l] = primaryHsl.split(" ");
        primaryColorRef.current = { h, s, l };
      }
    };

    getPrimaryColor();
    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);

    // Create particles
    const particleCount = 50;
    const particles: Particle[] = [];
    const randomValues = getSecureRandomValues(particleCount * 6);

    for (let i = 0; i < particleCount; i++) {
      particles.push({
        x: randomValues[i * 6] * canvas.width,
        y: randomValues[i * 6 + 1] * canvas.height,
        vx: (randomValues[i * 6 + 2] - 0.5) * 0.5,
        vy: (randomValues[i * 6 + 3] - 0.5) * 0.5,
        radius: randomValues[i * 6 + 4] * 3 + 1,
        opacity: randomValues[i * 6 + 5] * 0.5 + 0.2,
      });
    }

    particlesRef.current = particles;

    const animate = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const { h, s, l } = primaryColorRef.current;

      particlesRef.current.forEach((particle) => {
        // Update position
        particle.x += particle.vx;
        particle.y += particle.vy;

        // Bounce off walls
        if (particle.x < 0 || particle.x > canvas.width) {
          particle.vx = -particle.vx;
        }
        if (particle.y < 0 || particle.y > canvas.height) {
          particle.vy = -particle.vy;
        }

        // Draw particle using dynamic HSLA
        ctx.beginPath();
        ctx.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${h}, ${s}, ${l}, ${particle.opacity})`;
        ctx.fill();
      });

      // Draw connections between nearby particles
      particlesRef.current.forEach((particle1, i) => {
        particlesRef.current.slice(i + 1).forEach((particle2) => {
          const dx = particle1.x - particle2.x;
          const dy = particle1.y - particle2.y;
          const distance = Math.sqrt(dx * dx + dy * dy);

          if (distance < 150) {
            ctx.beginPath();
            ctx.moveTo(particle1.x, particle1.y);
            ctx.lineTo(particle2.x, particle2.y);
            // Use dynamic HSLA for stroke
            ctx.strokeStyle = `hsla(${h}, ${s}, ${l}, ${0.1 * (1 - distance / 150)})`;
            ctx.lineWidth = 0.5;
            ctx.stroke();
          }
        });
      });

      animationRef.current = requestAnimationFrame(animate);
    };

    animate();

    return () => {
      window.removeEventListener("resize", resizeCanvas);
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full"
      style={{
        background:
          "linear-gradient(135deg, hsl(var(--primary) / 0.1) 0%, hsl(var(--primary) / 0.05) 100%)",
      }}
    />
  );
};

export default ParticleBackground;
