// src/lib/three/shaders/WormholeShader.js

const WormholeVertexShader = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const WormholeFragmentShader = /* glsl */`
  uniform sampler2D uDiffuseMap;
  uniform sampler2D uEmissiveMap;
  uniform sampler2D uNormalMap;
  uniform float uTime;
  uniform vec2 uOffsetSpeed;
  uniform float uEmissiveIntensity;
  uniform float uOpacity;

  varying vec2 vUv;

  void main() {
    // Calculate animated UVs. Texture wrapping (RepeatWrapping) is handled by texture settings.
    vec2 animatedUv = vUv + uTime * uOffsetSpeed;

    vec4 diffuseColor = texture2D(uDiffuseMap, animatedUv);
    vec4 emissiveColor = texture2D(uEmissiveMap, animatedUv);
    // If you wanted to use the normal map for lighting:
    // vec3 normalVector = normalize(texture2D(uNormalMap, animatedUv).xyz * 2.0 - 1.0);

    // Combine base color from diffuse map with emissive color scaled by intensity
    vec3 finalColor = diffuseColor.rgb + emissiveColor.rgb * uEmissiveIntensity;
    
    // Output final color with opacity (using diffuse map's alpha component multiplied by global opacity if available, otherwise original alpha)
    float combinedOpacity = diffuseColor.a * uOpacity;
    gl_FragColor = vec4(finalColor, combinedOpacity);
  }
`;

export { WormholeVertexShader, WormholeFragmentShader };
