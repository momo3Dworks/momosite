
"use client";

import React, { useRef, useEffect, useCallback, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { CopyShader } from 'three/examples/jsm/shaders/CopyShader.js';
import { useToast } from "@/hooks/use-toast";

// Bloom effect parameters
const bloomParams = {
  threshold: 0.3, 
  strength: 0.5,  
  radius: 0.4,    
};

// Spaceship mouse interaction parameters
const mouseFollowSpeed = 0.07; 
const shipRotationFactor = 0.4; 
const shipMaxTilt = Math.PI / 9; 
const parallaxFactorX = 6; 
const parallaxFactorY = 3; 
const SHIP_INTRO_ANIMATION_SPEED = 0.03;

// Trail Particle Parameters
const MAX_TRAIL_PARTICLES = 150; 
const PARTICLE_LIFETIME_MIN = 0.8; 
const PARTICLE_LIFETIME_MAX = 1.5; 
const PARTICLE_EMISSION_INTENSITY_THRESHOLD = 40.0; 
const EFFECTIVE_EMISSION_RATE = 250.0; 
const PARTICLE_SPEED_MIN = 4.0; 
const PARTICLE_SPEED_MAX = 7.0; 
const PARTICLE_BASE_SIZE = 0.2; 
const PARTICLE_EMISSION_OFFSET = -0.35;

// Acceleration Effect Parameters
const FORWARD_BOOST_AMOUNT = 40; // How much the ship lurches forward on scroll
const FOV_DECREASE_AMOUNT = 30; // How much the FOV narrows on scroll
const ACCELERATION_EFFECT_LERP_SPEED = 0.1; // Speed of FOV and boost interpolation
const SCROLL_DIRECTION_FOR_EFFECTS: 'down' | 'up' | 'both' = 'down'; // Configurable: 'down', 'up', or 'both'


const speedLinesVertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const speedLinesFragmentShader = `
  uniform sampler2D tDiffuse;
  uniform vec2 u_resolution;
  uniform float u_time;
  uniform float u_scroll_active; // 0.0 (not scrolling) or 1.0 (scrolling)
  varying vec2 vUv;

  float random(vec2 st) {
      return fract(sin(dot(st.xy, vec2(12.9898,78.233))) * 43758.5453123);
  }

  void main() {
      vec4 originalColor = texture2D(tDiffuse, vUv);
      vec3 finalColor = originalColor.rgb;

      if (u_scroll_active > 0.01) { // Apply effect if scrolling is active
          vec2 to_center = vec2(0.5) - vUv;
          float dist_to_center = length(to_center);
          
          float line_intensity = 0.0;
          
          // Radial streaks from edges
          float streaks = 0.0;
          if (dist_to_center > 0.05) { // Avoid center
              float angle = atan(to_center.y, to_center.x);
              float num_lines = 30.0; // Number of distinct streak lines
              float time_component = u_time * (2.0 + u_scroll_active * 3.0); // Faster animation when scrolling

              for (float i = 0.0; i < num_lines; i += 1.0) {
                  float line_progress = fract(random(vec2(i, i * 0.73)) + time_component * (0.02 + random(vec2(i*0.2,0.0)) * 0.03));
                  float line_angle = random(vec2(i * 0.3, i * 0.91)) * 6.283185;
                  
                  float current_line_dist = abs(dist_to_center - (0.5 - line_progress * 0.5));
                  float angle_diff = abs(mod(angle - line_angle + 3.14159, 6.283185) - 3.14159);
                  
                  float streak_brightness = smoothstep(0.015, 0.0, current_line_dist) * smoothstep(0.1, 0.0, angle_diff);
                  streak_brightness *= (0.5 + line_progress * 0.5); // Fade in/out along length

                  streaks += streak_brightness;
              }
          }
          
          line_intensity = clamp(streaks * u_scroll_active * 0.2, 0.0, 0.25); // Control overall intensity
          vec3 speed_line_color = vec3(0.9, 0.9, 1.0) * line_intensity;
          finalColor += speed_line_color;
      }

      gl_FragColor = vec4(finalColor, originalColor.a);
  }
`;


const ScrollSurferScene: React.FC = () => {
  const mountRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const spaceshipRef = useRef<THREE.Group | null>(null);
  const wormholeRef = useRef<THREE.Group | null>(null); // Ref for wormhole model
  const composerRef = useRef<EffectComposer | null>(null);
  const bloomPassRef = useRef<UnrealBloomPass | null>(null);
  const speedLinesPassRef = useRef<ShaderPass | null>(null);
  const mixerRef = useRef<THREE.AnimationMixer | null>(null); 
  
  const trailParticlesRef = useRef<Array<any>>([]);
  const trailParticleContainerRef = useRef<THREE.Group | null>(null);
  const particleGeometryRef = useRef<THREE.PlaneGeometry | null>(null);
  const particleMaterialRef = useRef<THREE.MeshBasicMaterial | null>(null);

  const wormholeMaterial1Ref = useRef<THREE.MeshStandardMaterial | null>(null);
  const wormholeMaterial2Ref = useRef<THREE.MeshStandardMaterial | null>(null);

  const { toast } = useToast();

  const mousePositionRef = useRef(new THREE.Vector2(0, 0));
  const targetShipPositionRef = useRef(new THREE.Vector3(0, 0, 0));
  const isMouseOutsideRef = useRef(false);
  const shipIntroAnimationCompleteRef = useRef(false);

  // Camera initial state (configurable in code)
  const [cameraPosX, setCameraPosX] = useState(0); 
  const [cameraPosY, setCameraPosY] = useState(1.5); 
  const [cameraPosZ, setCameraPosZ] = useState(8); 
  const [cameraRotX, setCameraRotX] = useState(-0.05); 
  const [cameraRotY, setCameraRotY] = useState(0); 
  const [cameraRotZ, setCameraRotZ] = useState(0); 
  const [cameraFov, setCameraFov] = useState(70); 

  // Spaceship initial state (configurable in code)
  const [shipBasePosX, setShipBasePosX] = useState(0); 
  const [shipBasePosY, setShipBasePosY] = useState(-1.5); 
  const [shipBasePosZ, setShipBasePosZ] = useState(-4); 
  const [shipRotX, setShipRotX] = useState(0); 
  const [shipRotY, setShipRotY] = useState(Math.PI); 
  const [shipRotZState, setShipRotZState] = useState(0); 
  const [shipScale, setShipScale] = useState(0.45); 

  // Spaceship emissive intensity state
  const [shipEmissiveIntensity, setShipEmissiveIntensity] = useState(10.0); // Initial/Resting intensity
  const targetEmissiveIntensityRef = useRef(30.0);
  const isScrollingRef = useRef(false); // This ref specifically means "effects are active"
  const scrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastScrollTopRef = useRef(0);

  // Wormhole initial state (configurable in code)
  const [wormholePosX, setWormholePosX] = useState(0); 
  const [wormholePosY, setWormholePosY] = useState(0); 
  const [wormholePosZ, setWormholePosZ] = useState(1000); 
  const [wormholeRotX, setWormholeRotX] = useState(0); 
  const [wormholeRotY, setWormholeRotY] = useState(0); 
  const [wormholeRotZ, setWormholeRotZ] = useState(0); 
  const [wormholeScale, setWormholeScale] = useState(10); 

  // Wormhole material states (configurable in code)
  const [wormhole1EmissiveIntensity, setWormhole1EmissiveIntensity] = useState(45.0);
  const [wormhole1OffsetXSpeed, setWormhole1OffsetXSpeed] = useState(0.02);
  const [wormhole1OffsetYSpeed, setWormhole1OffsetYSpeed] = useState(-0.06);

  const [wormhole2EmissiveIntensity, setWormhole2EmissiveIntensity] = useState(25.0);
  const [wormhole2OffsetXSpeed, setWormhole2OffsetXSpeed] = useState(0.02);
  const [wormhole2OffsetYSpeed, setWormhole2OffsetYSpeed] = useState(-0.09);

  // Acceleration effect refs
  const targetShipBoostZOffsetRef = useRef(0);
  const currentShipBoostZOffsetRef = useRef(0);
  const targetCameraFovForBoostRef = useRef(cameraFov); // Initialized with base cameraFov
  
  const emitTrailParticle = useCallback(() => {
    if (!spaceshipRef.current || !trailParticleContainerRef.current || !particleGeometryRef.current || !particleMaterialRef.current || !cameraRef.current) return;
    if (trailParticlesRef.current.length >= MAX_TRAIL_PARTICLES) return;

    const spaceship = spaceshipRef.current;
    const particle = new THREE.Mesh(particleGeometryRef.current, particleMaterialRef.current.clone()); 

    const shipWorldPosition = new THREE.Vector3();
    spaceship.getWorldPosition(shipWorldPosition);
    const shipWorldQuaternion = new THREE.Quaternion();
    spaceship.getWorldQuaternion(shipWorldQuaternion);

    const offsetVector = new THREE.Vector3(0, 0, PARTICLE_EMISSION_OFFSET); 
    offsetVector.applyQuaternion(shipWorldQuaternion);
    particle.position.copy(shipWorldPosition).add(offsetVector);
    
    const baseVelocity = new THREE.Vector3(0, 0, -(PARTICLE_SPEED_MIN + Math.random() * (PARTICLE_SPEED_MAX - PARTICLE_SPEED_MIN)));
    baseVelocity.applyQuaternion(shipWorldQuaternion); 

    baseVelocity.x += (Math.random() - 0.5) * 0.5;
    baseVelocity.y += (Math.random() - 0.5) * 0.5;
    baseVelocity.z += (Math.random() - 0.5) * 0.5;

    const lifetime = PARTICLE_LIFETIME_MIN + Math.random() * (PARTICLE_LIFETIME_MAX - PARTICLE_LIFETIME_MIN);
    
    trailParticleContainerRef.current.add(particle);
    trailParticlesRef.current.push({
      mesh: particle,
      velocity: baseVelocity,
      life: lifetime,
      maxLife: lifetime,
      initialScale: PARTICLE_BASE_SIZE + (Math.random() - 0.5) * PARTICLE_BASE_SIZE * 0.3,
    });
  }, []);


  const initThreeScene = useCallback((currentMount: HTMLDivElement) => {
    if (!currentMount || rendererRef.current) return;

    console.log("Initializing Three.js scene...");

    const scene = new THREE.Scene();
    sceneRef.current = scene;
    scene.fog = new THREE.Fog(0xffffff, 80, 300); 
    targetShipPositionRef.current.set(shipBasePosX, shipBasePosY, shipBasePosZ);
    targetCameraFovForBoostRef.current = cameraFov; 


    const camera = new THREE.PerspectiveCamera(cameraFov, currentMount.clientWidth / currentMount.clientHeight, 0.1, 1000);
    cameraRef.current = camera;
    camera.position.set(cameraPosX, cameraPosY, cameraPosZ);
    camera.rotation.set(cameraRotX, cameraRotY, cameraRotZ);
    
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(currentMount.clientWidth, currentMount.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    currentMount.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Effect Composer Setup
    const composer = new EffectComposer(renderer);
    composerRef.current = composer;

    const renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);

    const bloomPassInstance = new UnrealBloomPass(
        new THREE.Vector2(currentMount.clientWidth, currentMount.clientHeight),
        bloomParams.strength,
        bloomParams.radius,
        bloomParams.threshold
    );
    bloomPassRef.current = bloomPassInstance;
    composer.addPass(bloomPassInstance);

    // Speed Lines Pass
    const speedLinesMaterial = new THREE.ShaderMaterial({
        uniforms: {
            tDiffuse: { value: null },
            u_resolution: { value: new THREE.Vector2(currentMount.clientWidth, currentMount.clientHeight) },
            u_time: { value: 0.0 },
            u_scroll_active: { value: 0.0 },
        },
        vertexShader: speedLinesVertexShader,
        fragmentShader: speedLinesFragmentShader,
    });
    const speedLinesPassInstance = new ShaderPass(speedLinesMaterial);
    speedLinesPassRef.current = speedLinesPassInstance;
    composer.addPass(speedLinesPassInstance);


    const finalPass = new ShaderPass(CopyShader);
    finalPass.renderToScreen = true; 
    composer.addPass(finalPass);


    // Particle resources
    particleGeometryRef.current = new THREE.PlaneGeometry(1, 1); 
    particleMaterialRef.current = new THREE.MeshBasicMaterial({
        color: 0xffffff, 
        transparent: true,
        opacity: 1.0,
        blending: THREE.AdditiveBlending, 
        depthWrite: false, 
    });
    trailParticleContainerRef.current = new THREE.Group();
    scene.add(trailParticleContainerRef.current);


    const rgbeLoader = new RGBELoader();
    rgbeLoader.load(
      '/hdri/sky_1.hdr',
      (texture) => {
        texture.mapping = THREE.EquirectangularReflectionMapping;
        scene.environment = texture;
        scene.background = texture; 
        console.log('HDRI loaded and set for environment and background.');
      },
      undefined,
      (error) => {
        console.error('Error loading HDRI:', error);
        scene.background = new THREE.Color(0x05050a); 
        toast({ variant: 'destructive', title: 'HDRI Load Error', description: 'Could not load /hdri/sky_1.hdr. Using default dark background.' });
      }
    );
    
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.05); 
    scene.add(ambientLight);
    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.02); 
    directionalLight.position.set(2, 5, -5);
    scene.add(directionalLight);

    const loader = new GLTFLoader();
    loader.load(
      '/models/spaceship.glb',
      (gltf) => {
        const spaceship = gltf.scene;
        spaceshipRef.current = spaceship;
        
        const initialOffScreenZ = shipBasePosZ - -60; 
        spaceship.position.set(shipBasePosX, shipBasePosY, initialOffScreenZ);
        shipIntroAnimationCompleteRef.current = false; 

        spaceship.rotation.set(shipRotX, shipRotY, shipRotZState);
        spaceship.scale.set(shipScale, shipScale, shipScale);
        
        spaceship.traverse((child) => {
          if (child instanceof THREE.Mesh && child.material) {
            const materials = Array.isArray(child.material) ? child.material : [child.material];
            materials.forEach(material => {
              if ((material as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
                const standardMaterial = material as THREE.MeshStandardMaterial;
                if (standardMaterial.emissiveMap) {
                  standardMaterial.emissiveIntensity = 30.0; // Initial emissive state
                  standardMaterial.needsUpdate = true;
                }
              }
            });
          }
        });
        scene.add(spaceship);
        console.log('Spaceship model loaded.');

        if (gltf.animations && gltf.animations.length) {
          mixerRef.current = new THREE.AnimationMixer(spaceship);
          gltf.animations.forEach((clip) => {
            if(mixerRef.current){
              const action = mixerRef.current.clipAction(clip);
              action.play();
            }
          });
          console.log(`Loaded ${gltf.animations.length} animations for spaceship.`);
        } else {
          console.log('No animations found in spaceship.glb.');
        }

      },
      undefined,
      (error) => {
        console.error('Error loading spaceship model:', error);
        toast({ variant: "destructive", title: "Spaceship load error", description: "Could not load /models/spaceship.glb." });
      }
    );

    loader.load(
      '/models/WORMHOLE.glb',
      (gltf) => {
        const wormhole = gltf.scene;
        wormholeRef.current = wormhole;
        wormhole.position.set(wormholePosX, wormholePosY, wormholePosZ);
        wormhole.rotation.set(wormholeRotX, wormholeRotY, wormholeRotZ);
        wormhole.scale.set(wormholeScale, wormholeScale, wormholeScale);
        
        wormhole.traverse((child) => {
          if (child instanceof THREE.Mesh && child.material) {
            const material = child.material as THREE.MeshStandardMaterial;
            if (material.name === "WORMHOLE 1") {
              wormholeMaterial1Ref.current = material;
              material.emissiveIntensity = wormhole1EmissiveIntensity;
              if (material.map) { material.map.wrapS = material.map.wrapT = THREE.RepeatWrapping; }
              if (material.emissiveMap) { material.emissiveMap.wrapS = material.emissiveMap.wrapT = THREE.RepeatWrapping; }
              if (material.normalMap) { material.normalMap.wrapS = material.normalMap.wrapT = THREE.RepeatWrapping; }
            } else if (material.name === "WORMHOLE 2") {
              wormholeMaterial2Ref.current = material;
              material.emissiveIntensity = wormhole2EmissiveIntensity;
              if (material.map) { material.map.wrapS = material.map.wrapT = THREE.RepeatWrapping; }
              if (material.emissiveMap) { material.emissiveMap.wrapS = material.emissiveMap.wrapT = THREE.RepeatWrapping; }
              if (material.normalMap) { material.normalMap.wrapS = material.normalMap.wrapT = THREE.RepeatWrapping; }
            }
          }
        });
        scene.add(wormhole);
        console.log('Wormhole model loaded.');
      },
      undefined,
      (error) => {
        console.error('Error loading wormhole model:', error);
        toast({ variant: "destructive", title: "Wormhole load error", description: "Could not load /models/WORMHOLE.glb." });
      }
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    toast, 
    shipBasePosX, shipBasePosY, shipBasePosZ, 
    shipRotX, shipRotY, shipRotZState, shipScale, 
    wormholePosX, wormholePosY, wormholePosZ,
    wormholeRotX, wormholeRotY, wormholeRotZ, wormholeScale,
    wormhole1EmissiveIntensity, 
    wormhole2EmissiveIntensity, 
    cameraPosX, cameraPosY, cameraPosZ, cameraRotX, cameraRotY, cameraRotZ, cameraFov
  ]); 

  useEffect(() => {
    if (spaceshipRef.current) {
      spaceshipRef.current.traverse((child) => {
        if (child instanceof THREE.Mesh && child.material) {
          const materials = Array.isArray(child.material) ? child.material : [child.material];
          materials.forEach(material => {
            if ((material as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
              const standardMaterial = material as THREE.MeshStandardMaterial;
              if (standardMaterial.emissiveMap) { 
                standardMaterial.emissiveIntensity = shipEmissiveIntensity;
                standardMaterial.needsUpdate = true; 
              }
            }
          });
        }
      });
    }
  }, [shipEmissiveIntensity]);

  useEffect(() => {
    if (wormholeMaterial1Ref.current) {
      wormholeMaterial1Ref.current.emissiveIntensity = wormhole1EmissiveIntensity;
      wormholeMaterial1Ref.current.needsUpdate = true;
    }
    if (wormholeMaterial2Ref.current) {
      wormholeMaterial2Ref.current.emissiveIntensity = wormhole2EmissiveIntensity;
      wormholeMaterial2Ref.current.needsUpdate = true;
    }
  }, [wormhole1EmissiveIntensity, wormhole2EmissiveIntensity]);

  // Effect for initializing targetCameraFovForBoostRef when cameraFov changes
  useEffect(() => {
    targetCameraFovForBoostRef.current = cameraFov;
  }, [cameraFov]);


  const handleScroll = useCallback(() => {
    const scrollTop = window.scrollY;
    const scrollDelta = scrollTop - lastScrollTopRef.current;

    let activateEffectsThisTick = false;
    if (scrollDelta > 0 && SCROLL_DIRECTION_FOR_EFFECTS === 'down') {
        activateEffectsThisTick = true;
    } else if (scrollDelta < 0 && SCROLL_DIRECTION_FOR_EFFECTS === 'up') {
        activateEffectsThisTick = true;
    } else if (scrollDelta !== 0 && SCROLL_DIRECTION_FOR_EFFECTS === 'both') {
        activateEffectsThisTick = true;
    }

    if (activateEffectsThisTick) {
        if (!isScrollingRef.current) { // Effects were off, just turned on
            targetEmissiveIntensityRef.current = 100.0; 
        } else { // Effects already on, vary intensity with scroll speed
            const scrollSpeedFactor = Math.min(Math.abs(scrollDelta) / 50.0, 1.0); 
            targetEmissiveIntensityRef.current = 90.0 + scrollSpeedFactor * 10.0; 
        }
        targetEmissiveIntensityRef.current = Math.max(90.0, Math.min(100.0, targetEmissiveIntensityRef.current));
        
        targetShipBoostZOffsetRef.current = -FORWARD_BOOST_AMOUNT;
        if (cameraRef.current) targetCameraFovForBoostRef.current = cameraFov - FOV_DECREASE_AMOUNT;
        isScrollingRef.current = true; // Mark effects as active
    } else {
        // Scroll not in desired direction, or no scroll (delta is 0)
        // If effects were active and now the condition is not met, turn them off.
        isScrollingRef.current = false;
        targetEmissiveIntensityRef.current = 30.0;
        targetShipBoostZOffsetRef.current = 0;
        if (cameraRef.current) targetCameraFovForBoostRef.current = cameraFov;
    }
    
    lastScrollTopRef.current = scrollTop;

    // Clear previous timeout and set a new one to handle the "scroll stopped" case
    if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
    scrollTimeoutRef.current = setTimeout(() => {
        isScrollingRef.current = false; // Scrolling stopped, turn effects off
        targetEmissiveIntensityRef.current = 30.0;
        targetShipBoostZOffsetRef.current = 0;
        if (cameraRef.current) targetCameraFovForBoostRef.current = cameraFov;
    }, 150);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraFov]); // FOV_DECREASE_AMOUNT and FORWARD_BOOST_AMOUNT are constants


  useEffect(() => {
    if (!mountRef.current) return;
    const currentMount = mountRef.current;
    
    if (!rendererRef.current) { 
      initThreeScene(currentMount);
    }
    
    const clock = new THREE.Clock();

    const handleMouseMove = (event: MouseEvent) => {
        isMouseOutsideRef.current = false;
        if (currentMount) { 
            const newMouseX = (event.clientX / currentMount.clientWidth) * 2 - 1;
            const newMouseY = -(event.clientY / currentMount.clientHeight) * 2 + 1;
            mousePositionRef.current.set(newMouseX, newMouseY);
        }
    };
    window.addEventListener('mousemove', handleMouseMove);

    const handleDocumentMouseLeave = () => { isMouseOutsideRef.current = true; };
    document.documentElement.addEventListener('mouseleave', handleDocumentMouseLeave);
    const handleDocumentMouseEnter = () => { isMouseOutsideRef.current = false; };
    document.documentElement.addEventListener('mouseenter', handleDocumentMouseEnter);

    let animationFrameId: number;
    const animate = () => {
      animationFrameId = requestAnimationFrame(animate);
      const deltaTime = clock.getDelta();

      if (mixerRef.current) {
        mixerRef.current.update(deltaTime);
      }

      // Lerp ship emissive intensity
      if (Math.abs(shipEmissiveIntensity - targetEmissiveIntensityRef.current) > 0.01) {
        const lerpFactor = Math.min(deltaTime * 5.0, 1.0); 
        let newIntensity = THREE.MathUtils.lerp(shipEmissiveIntensity, targetEmissiveIntensityRef.current, lerpFactor); 
        setShipEmissiveIntensity(newIntensity);
      }

      // Lerp camera FOV for boost effect
      if (cameraRef.current && Math.abs(cameraRef.current.fov - targetCameraFovForBoostRef.current) > 0.01) {
        cameraRef.current.fov = THREE.MathUtils.lerp(cameraRef.current.fov, targetCameraFovForBoostRef.current, ACCELERATION_EFFECT_LERP_SPEED);
        cameraRef.current.updateProjectionMatrix();
      }

      // Lerp ship Z boost offset
      currentShipBoostZOffsetRef.current = THREE.MathUtils.lerp(
        currentShipBoostZOffsetRef.current,
        targetShipBoostZOffsetRef.current,
        ACCELERATION_EFFECT_LERP_SPEED
      );

      if (wormholeMaterial1Ref.current) {
        const mat1 = wormholeMaterial1Ref.current;
        if (mat1.map) { mat1.map.offset.x += wormhole1OffsetXSpeed * deltaTime; mat1.map.offset.y += wormhole1OffsetYSpeed * deltaTime; }
        if (mat1.emissiveMap) { mat1.emissiveMap.offset.x += wormhole1OffsetXSpeed * deltaTime; mat1.emissiveMap.offset.y += wormhole1OffsetYSpeed * deltaTime; }
        if (mat1.normalMap) { mat1.normalMap.offset.x += wormhole1OffsetXSpeed * deltaTime; mat1.normalMap.offset.y += wormhole1OffsetYSpeed * deltaTime; }
      }
      if (wormholeMaterial2Ref.current) {
        const mat2 = wormholeMaterial2Ref.current;
        if (mat2.map) { mat2.map.offset.x += wormhole2OffsetXSpeed * deltaTime; mat2.map.offset.y += wormhole2OffsetYSpeed * deltaTime; }
        if (mat2.emissiveMap) { mat2.emissiveMap.offset.x += wormhole2OffsetXSpeed * deltaTime; mat2.emissiveMap.offset.y += wormhole2OffsetYSpeed * deltaTime; }
        if (mat2.normalMap) { mat2.normalMap.offset.x += wormhole2OffsetXSpeed * deltaTime; mat2.normalMap.offset.y += wormhole2OffsetYSpeed * deltaTime; }
      }

      if (spaceshipRef.current) {
        if (!shipIntroAnimationCompleteRef.current) {
            const targetIntroPosition = new THREE.Vector3(shipBasePosX, shipBasePosY, shipBasePosZ);
            spaceshipRef.current.position.lerp(targetIntroPosition, SHIP_INTRO_ANIMATION_SPEED);

            if (spaceshipRef.current.position.distanceTo(targetIntroPosition) < 0.01) {
                spaceshipRef.current.position.copy(targetIntroPosition);
                shipIntroAnimationCompleteRef.current = true;
            }
        } else { 
            let currentInputMouseX = mousePositionRef.current.x;
            let currentInputMouseY = mousePositionRef.current.y;

            if (isMouseOutsideRef.current) {
                currentInputMouseX = 0; 
                currentInputMouseY = 0; 
            }
            
            targetShipPositionRef.current.x = currentInputMouseX * parallaxFactorX + shipBasePosX;
            targetShipPositionRef.current.y = currentInputMouseY * parallaxFactorY + shipBasePosY;
            targetShipPositionRef.current.z = shipBasePosZ + currentShipBoostZOffsetRef.current; 

            spaceshipRef.current.position.lerp(targetShipPositionRef.current, mouseFollowSpeed);

            const baseForwardRotationY = shipRotY; 
            const targetPitch = shipRotX - THREE.MathUtils.clamp(currentInputMouseY * shipRotationFactor * 0.7, -shipMaxTilt, shipMaxTilt);
            const targetYaw = baseForwardRotationY - THREE.MathUtils.clamp(currentInputMouseX * shipRotationFactor * 0.5, -shipMaxTilt * 0.8, shipMaxTilt * 0.8);
            const targetRoll = shipRotZState - THREE.MathUtils.clamp(currentInputMouseX * shipRotationFactor, -shipMaxTilt, shipMaxTilt);

            spaceshipRef.current.rotation.x = THREE.MathUtils.lerp(spaceshipRef.current.rotation.x, targetPitch, mouseFollowSpeed);
            spaceshipRef.current.rotation.y = THREE.MathUtils.lerp(spaceshipRef.current.rotation.y, targetYaw, mouseFollowSpeed);
            spaceshipRef.current.rotation.z = THREE.MathUtils.lerp(spaceshipRef.current.rotation.z, targetRoll, mouseFollowSpeed);
        }
      }

      if (spaceshipRef.current && shipEmissiveIntensity > PARTICLE_EMISSION_INTENSITY_THRESHOLD) {
        const emissionChanceFactor = Math.min(1.0, (shipEmissiveIntensity - PARTICLE_EMISSION_INTENSITY_THRESHOLD) / (100.0 - PARTICLE_EMISSION_INTENSITY_THRESHOLD));
        const numToEmit = Math.floor(emissionChanceFactor * EFFECTIVE_EMISSION_RATE * deltaTime);
        for (let k = 0; k < numToEmit; k++) {
             if (Math.random() < emissionChanceFactor) emitTrailParticle(); 
        }
      }

      if (trailParticlesRef.current.length > 0 && cameraRef.current) {
        for (let i = trailParticlesRef.current.length - 1; i >= 0; i--) {
          const p = trailParticlesRef.current[i];
          p.life -= deltaTime;

          if (p.life <= 0) {
            trailParticleContainerRef.current?.remove(p.mesh);
            p.mesh.geometry.dispose();
            if (p.mesh.material.map) p.mesh.material.map.dispose(); 
            p.mesh.material.dispose();
            trailParticlesRef.current.splice(i, 1);
          } else {
            p.mesh.position.addScaledVector(p.velocity, deltaTime);
            const lifeRatio = p.life / p.maxLife;
            p.mesh.material.opacity = lifeRatio;
            const currentScale = p.initialScale * (0.5 + lifeRatio * 0.5); 
            p.mesh.scale.set(currentScale, currentScale, currentScale);
            p.mesh.lookAt(cameraRef.current.position); 
          }
        }
      }

      if (speedLinesPassRef.current && rendererRef.current) {
          speedLinesPassRef.current.uniforms.u_time.value = clock.getElapsedTime();
          speedLinesPassRef.current.uniforms.u_scroll_active.value = isScrollingRef.current ? 1.0 : 0.0;
          speedLinesPassRef.current.uniforms.u_resolution.value.set(
            rendererRef.current.domElement.width,
            rendererRef.current.domElement.height
          );
      }
      
      composerRef.current?.render(deltaTime);
    };
    animate();

    const handleResize = () => {
      if (!mountRef.current || !rendererRef.current || !cameraRef.current || !composerRef.current) return;
      const width = currentMount.clientWidth;
      const height = currentMount.clientHeight;
      
      cameraRef.current.aspect = width / height;
      cameraRef.current.updateProjectionMatrix();
      
      rendererRef.current.setSize(width, height);
      composerRef.current.setSize(width, height);
      if (bloomPassRef.current) {
         bloomPassRef.current.setSize(width, height);
      }
      if (speedLinesPassRef.current) {
        speedLinesPassRef.current.uniforms.u_resolution.value.set(width, height);
      }
    };
    window.addEventListener('resize', handleResize);
    handleResize(); 

    window.addEventListener('scroll', handleScroll, { passive: true });
    lastScrollTopRef.current = window.scrollY; // Initialize lastScrollTopRef

    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('scroll', handleScroll);
      window.removeEventListener('mousemove', handleMouseMove);
      document.documentElement.removeEventListener('mouseleave', handleDocumentMouseLeave);
      document.documentElement.removeEventListener('mouseenter', handleDocumentMouseEnter);
      if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
      
      trailParticlesRef.current.forEach(p => {
        if(trailParticleContainerRef.current) trailParticleContainerRef.current.remove(p.mesh);
        p.mesh.geometry.dispose();
        if (p.mesh.material.map) p.mesh.material.map.dispose();
        p.mesh.material.dispose();
      });
      trailParticlesRef.current = [];
      if (particleGeometryRef.current) particleGeometryRef.current.dispose();
      if (particleMaterialRef.current) particleMaterialRef.current.dispose();


      if (rendererRef.current && currentMount && rendererRef.current.domElement.parentNode === currentMount) {
         currentMount.removeChild(rendererRef.current.domElement);
      }
      
      composerRef.current?.dispose();
      if (bloomPassRef.current) bloomPassRef.current.dispose(); 
      if (speedLinesPassRef.current) speedLinesPassRef.current.material.dispose(); 
      
      rendererRef.current?.dispose();       
      
      sceneRef.current?.traverse(object => {
        if (object instanceof THREE.Mesh) {
          if (object.geometry) object.geometry.dispose();
          if (Array.isArray(object.material)) {
            object.material.forEach(mat => mat.dispose());
          } else if (object.material) {
            object.material.dispose();
          }
        }
      });
      if (sceneRef.current?.environment && typeof (sceneRef.current.environment as THREE.Texture).dispose === 'function') {
          (sceneRef.current.environment as THREE.Texture).dispose();
      }
      if (sceneRef.current?.background && typeof (sceneRef.current.background as THREE.Texture).dispose === 'function') {
        (sceneRef.current.background as THREE.Texture).dispose();
      }

      if (mixerRef.current) { 
        mixerRef.current.stopAllAction();
        mixerRef.current = null;
      }

      sceneRef.current = null; 
      cameraRef.current = null;
      spaceshipRef.current = null;
      wormholeRef.current = null;
      wormholeMaterial1Ref.current = null;
      wormholeMaterial2Ref.current = null;
      rendererRef.current = null; 
      composerRef.current = null;
      bloomPassRef.current = null;
      speedLinesPassRef.current = null;
      trailParticleContainerRef.current = null;
      particleGeometryRef.current = null;
      particleMaterialRef.current = null;

      console.log("Three.js scene cleaned up.");
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    initThreeScene, 
    emitTrailParticle, 
    handleScroll, // Add handleScroll here as it's now a useCallback
    wormhole1OffsetXSpeed, wormhole1OffsetYSpeed, wormhole2OffsetXSpeed, wormhole2OffsetYSpeed
  ]);

  return (
    <>
      <div ref={mountRef} style={{ width: '100vw', height: '100vh', position: 'fixed', top: 0, left: 0, zIndex: 0 }} />
    </>
  );
};

export default ScrollSurferScene;


