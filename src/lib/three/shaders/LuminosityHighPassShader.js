
import * as THREE from 'three';

const LuminosityHighPassShader = {

	shaderID: 'luminosityHighPass',

	uniforms: {
		'tDiffuse': { value: null },
		'luminosityThreshold': { value: 1.0 },
		'smoothWidth': { value: 1.0 },
		'defaultColor': { value: new THREE.Color( 0x000000 ) }, // Ensure THREE.Color is used
		'defaultOpacity': { value: 0.0 }
	},

	vertexShader: /* glsl */`
		varying vec2 vUv;
		void main() {
			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
		}`,

	fragmentShader: /* glsl */`
		uniform sampler2D tDiffuse;
		uniform vec3 defaultColor;
		uniform float defaultOpacity;
		uniform float luminosityThreshold;
		uniform float smoothWidth;
		varying vec2 vUv;
		void main() {
			vec4 texel = texture2D( tDiffuse, vUv );
			float l = dot( texel.rgb, vec3( 0.299, 0.587, 0.114 ) ); // Standard luminosity calculation
			float alpha = smoothstep( luminosityThreshold, luminosityThreshold + smoothWidth, l );
			gl_FragColor = mix( vec4( defaultColor, defaultOpacity ), texel, alpha );
		}`
};

export { LuminosityHighPassShader };

    