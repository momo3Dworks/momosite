
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { LuminosityHighPassShader } from '../shaders/LuminosityHighPassShader.js'; // Adjusted path
import { CopyShader } from '../shaders/CopyShader.js'; // Adjusted path

class UnrealBloomPass extends Pass {

	constructor( resolution, strength, radius, threshold ) {

		super();

		this.strength = ( strength !== undefined ) ? strength : 1;
		this.radius = radius;
		this.threshold = threshold;
		this.resolution = ( resolution !== undefined ) ? new THREE.Vector2( resolution.x, resolution.y ) : new THREE.Vector2( 256, 256 );

		// create color only frame buffer scene
		this.renderTargetBright = new THREE.WebGLRenderTarget( this.resolution.x, this.resolution.y, { type: THREE.HalfFloatType } );
		this.renderTargetBright.texture.name = 'UnrealBloomPass.bright';
		this.renderTargetBright.texture.generateMipmaps = false;

		// luminosity high pass material
		this.highPassUniforms = THREE.UniformsUtils.clone( LuminosityHighPassShader.uniforms );

		this.highPassUniforms[ 'luminosityThreshold' ].value = threshold;
		this.highPassUniforms[ 'smoothWidth' ].value = 0.01;

		this.materialHighPassFilter = new THREE.ShaderMaterial( {
			uniforms: this.highPassUniforms,
			vertexShader: LuminosityHighPassShader.vertexShader,
			fragmentShader: LuminosityHighPassShader.fragmentShader,
			defines: {}
		} );

		// Gaussian Blur Materials
		this.separableBlurMaterials = [];
		const kernelSizeArray = [ 3, 5, 7, 9, 11 ]; // KERNEL_RADIUS_ENUM in Unreal
		// let resX = Math.round( this.resolution.x / 2 );
		// let resY = Math.round( this.resolution.y / 2 );

        // UnrealBloomPass does not downsample for blur passes in the same way as some other bloom implementations.
        // The blurring is done on the renderTargetBright directly or its mipmaps if they were generated.
        // For simplicity and closer adherence to typical UnrealBloom implementations,
        // we will operate on renderTargetBright or ping-pong buffers of the same size for blur.
        // If downsampling were desired, renderTargetBlur would be used and its size adjusted.

        this.nMips = 5; // Similar to Unreal Engine's bloom, typically 5-6 mip levels

        this.renderTargetsHorizontal = [];
        this.renderTargetsVertical = [];
        this.mipPasses = [];

        let resX = this.resolution.x;
        let resY = this.resolution.y;

        for ( let i = 0; i < this.nMips; i ++ ) {

            const renderTargetHoriz = new THREE.WebGLRenderTarget( resX, resY, { type: THREE.HalfFloatType } );
            renderTargetHoriz.texture.name = 'UnrealBloomPass.h' + i;
            renderTargetHoriz.texture.generateMipmaps = false;
            this.renderTargetsHorizontal.push( renderTargetHoriz );

            const renderTargetVert = new THREE.WebGLRenderTarget( resX, resY, { type: THREE.HalfFloatType } );
            renderTargetVert.texture.name = 'UnrealBloomPass.v' + i;
            renderTargetVert.texture.generateMipmaps = false;
            this.renderTargetsVertical.push( renderTargetVert );

            const mipPass = new THREE.ShaderMaterial( {
                defines: {
                    'KERNEL_RADIUS': kernelSizeArray[ i ],
                    'SIGMA': kernelSizeArray[ i ] // Sigma is often same as kernel radius for Gaussian
                },
                uniforms: {
                    'tDiffuse': { value: null },
                    'texSize': { value: new THREE.Vector2( resX, resY ) },
                    'direction': { value: new THREE.Vector2( 0.5, 0.5 ) }
                },
                vertexShader:
                    `varying vec2 vUv;
                    void main() {
                        vUv = uv;
                        gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
                    }`,
                fragmentShader: // Gaussian Blur Shader
                    `uniform sampler2D tDiffuse;
                    uniform vec2 texSize;
                    uniform vec2 direction; // vec2(1.0, 0.0) for horizontal, vec2(0.0, 1.0) for vertical
                    varying vec2 vUv;
                    float gaussianPdf(in float x, in float sigma) {
                        return 0.39894 * exp( -0.5 * x * x/( sigma * sigma))/sigma;
                    }
                    void main() {
                        vec2 invSize = 1.0 / texSize;
                        float fSigma = float(SIGMA);
                        float weightSum = gaussianPdf(0.0, fSigma);
                        vec3 diffuseSum = texture2D( tDiffuse, vUv ).rgb * weightSum;
                        vec2 delta = direction * invSize * 1.0; // Pixel delta
                        for( int i = 1; i < KERNEL_RADIUS; i ++ ) {
                            float x = float(i);
                            float w = gaussianPdf(x, fSigma);
                            diffuseSum += texture2D( tDiffuse, vUv + delta * x ).rgb * w;
                            diffuseSum += texture2D( tDiffuse, vUv - delta * x ).rgb * w;
                            weightSum += 2.0 * w;
                        }
                        gl_FragColor = vec4(diffuseSum/weightSum, 1.0);
                    }`
            } );
            this.mipPasses.push(mipPass);

            resX = Math.max(1, Math.floor(resX / 2)); // Ensure size doesn't go to 0
            resY = Math.max(1, Math.floor(resY / 2));
        }


		// Composite material
		this.compositeMaterial = new THREE.ShaderMaterial( {
			defines: {
				'NUM_MIPS': this.nMips
			},
			uniforms: {
				'blurTexture1': { value: null },
				'blurTexture2': { value: null },
				'blurTexture3': { value: null },
				'blurTexture4': { value: null },
				'blurTexture5': { value: null },
				'bloomStrength': { value: 1.0 },
				'bloomRadius': { value: 0.0 },
				'bloomFactors': { value: null }, 
				'bloomTintColors': { value: null }, 
			},
			vertexShader:
				`varying vec2 vUv;
				void main() {
					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
				}`,
			fragmentShader:
				`varying vec2 vUv;
				uniform sampler2D blurTexture1;
				uniform sampler2D blurTexture2;
				uniform sampler2D blurTexture3;
				uniform sampler2D blurTexture4;
				uniform sampler2D blurTexture5;
				uniform float bloomStrength;
				uniform float bloomRadius; // 0 = All mips, 1 = Only Coarsest mips (higher radius means more influence from lower mips)
				uniform float bloomFactors[NUM_MIPS];
				uniform vec3 bloomTintColors[NUM_MIPS];

				float lerpBloomFactor(const in float factor) {
                    // Smoothly interpolate between bloom factor and its "mirrored" version based on bloomRadius
                    // This is a simplified interpretation. Original Unreal uses more complex weighting.
					float mirrorFactor = 1.2 - factor; // Example, can be adjusted
					return mix(factor, mirrorFactor, bloomRadius);
				}

				void main() {
					vec4 color = vec4(0.0);
					color += lerpBloomFactor(bloomFactors[0]) * vec4(bloomTintColors[0], 1.0) * texture2D(blurTexture1, vUv);
					color += lerpBloomFactor(bloomFactors[1]) * vec4(bloomTintColors[1], 1.0) * texture2D(blurTexture2, vUv);
					color += lerpBloomFactor(bloomFactors[2]) * vec4(bloomTintColors[2], 1.0) * texture2D(blurTexture3, vUv);
					color += lerpBloomFactor(bloomFactors[3]) * vec4(bloomTintColors[3], 1.0) * texture2D(blurTexture4, vUv);
					color += lerpBloomFactor(bloomFactors[4]) * vec4(bloomTintColors[4], 1.0) * texture2D(blurTexture5, vUv);
					gl_FragColor = bloomStrength * color;
				}`
		} );
		this.compositeMaterial.uniforms[ 'bloomFactors' ].value = [ 1.0, 0.8, 0.6, 0.4, 0.2 ];
		this.compositeMaterial.uniforms[ 'bloomTintColors' ].value = [ new THREE.Vector3( 1, 1, 1 ), new THREE.Vector3( 1, 1, 1 ), new THREE.Vector3( 1, 1, 1 ), new THREE.Vector3( 1, 1, 1 ), new THREE.Vector3( 1, 1, 1 ) ];


		// copy material
		this.copyUniforms = THREE.UniformsUtils.clone( CopyShader.uniforms );
		this.copyUniforms[ 'opacity' ].value = 1.0; // This will be set to strength in render

		this.materialCopy = new THREE.ShaderMaterial( {
			uniforms: this.copyUniforms,
			vertexShader: CopyShader.vertexShader,
			fragmentShader: CopyShader.fragmentShader,
			blending: THREE.AdditiveBlending,
			depthTest: false,
			depthWrite: false,
			transparent: true
		} );

		this.enabled = true;
		this.needsSwap = false;

		this._oldClearColor = new THREE.Color();
		this.oldClearAlpha = 1;

		this.basic = new THREE.MeshBasicMaterial();

		this.fsQuad = new FullScreenQuad( null );
	}

	dispose() {
		this.renderTargetBright.dispose();
        this.renderTargetsHorizontal.forEach(rt => rt.dispose());
        this.renderTargetsVertical.forEach(rt => rt.dispose());
        this.mipPasses.forEach(mp => mp.dispose());
		this.compositeMaterial.dispose();
		this.materialCopy.dispose();
		this.basic.dispose();
		this.fsQuad.dispose();
	}

	setSize( width, height ) {
		this.renderTargetBright.setSize( width, height );

        let resX = width;
        let resY = height;
        for ( let i = 0; i < this.nMips; i ++ ) {
            this.renderTargetsHorizontal[i].setSize(resX, resY);
            this.renderTargetsVertical[i].setSize(resX, resY);
            this.mipPasses[i].uniforms['texSize'].value.set(resX, resY);
            resX = Math.max(1, Math.floor(resX / 2));
            resY = Math.max(1, Math.floor(resY / 2));
        }
	}

	render( renderer, writeBuffer, readBuffer, deltaTime, maskActive ) {
		const oldAutoClear = renderer.autoClear;
		renderer.autoClear = false;

		renderer.getClearColor( this._oldClearColor );
		this.oldClearAlpha = renderer.getClearAlpha();

		if ( maskActive ) renderer.state.buffers.stencil.setTest( false );

		// 1. Extract Bright Areas
		this.highPassUniforms[ 'tDiffuse' ].value = readBuffer.texture;
		this.highPassUniforms[ 'luminosityThreshold' ].value = this.threshold;
		this.fsQuad.material = this.materialHighPassFilter;
		renderer.setRenderTarget( this.renderTargetBright );
		renderer.clear();
		this.fsQuad.render( renderer );

        // 2. Blur All Bright Areas (Mip Chain)
        let inputRenderTarget = this.renderTargetBright;

        for ( let i = 0; i < this.nMips; i ++ ) {
            this.fsQuad.material = this.mipPasses[i];
            // Horizontal blur
            this.mipPasses[i].uniforms[ 'tDiffuse' ].value = inputRenderTarget.texture;
            this.mipPasses[i].uniforms[ 'direction' ].value = UnrealBloomPass.BlurDirectionX;
            renderer.setRenderTarget( this.renderTargetsHorizontal[i] );
            renderer.clear();
            this.fsQuad.render( renderer );

            // Vertical blur
            this.mipPasses[i].uniforms[ 'tDiffuse' ].value = this.renderTargetsHorizontal[i].texture;
            this.mipPasses[i].uniforms[ 'direction' ].value = UnrealBloomPass.BlurDirectionY;
            renderer.setRenderTarget( this.renderTargetsVertical[i] );
            renderer.clear();
            this.fsQuad.render( renderer );

            inputRenderTarget = this.renderTargetsVertical[i]; // Output of this mip level becomes input for next (if downsampling was part of this loop)
        }

		// Composite All Blurs
		this.fsQuad.material = this.compositeMaterial;
		this.compositeMaterial.uniforms[ 'bloomStrength' ].value = this.strength;
		this.compositeMaterial.uniforms[ 'bloomRadius' ].value = this.radius;
		this.compositeMaterial.uniforms[ 'bloomTintColors' ].value = this.bloomTintColors || [ new THREE.Vector3( 1, 1, 1 ), new THREE.Vector3( 1, 1, 1 ), new THREE.Vector3( 1, 1, 1 ), new THREE.Vector3( 1, 1, 1 ), new THREE.Vector3( 1, 1, 1 ) ];
        this.compositeMaterial.uniforms[ 'bloomFactors' ].value = this.bloomFactors || [ 1.0, 0.8, 0.6, 0.4, 0.2 ];

        this.compositeMaterial.uniforms[ 'blurTexture1' ].value = this.renderTargetsVertical[0].texture;
        this.compositeMaterial.uniforms[ 'blurTexture2' ].value = this.renderTargetsVertical[1].texture;
        this.compositeMaterial.uniforms[ 'blurTexture3' ].value = this.renderTargetsVertical[2].texture;
        this.compositeMaterial.uniforms[ 'blurTexture4' ].value = this.renderTargetsVertical[3].texture;
        this.compositeMaterial.uniforms[ 'blurTexture5' ].value = this.renderTargetsVertical[4].texture;


        // Blend it additively over the input texture
        renderer.setRenderTarget(this.renderTargetBright); // Using renderTargetBright as a temporary buffer for composite
        renderer.clear();
        this.fsQuad.render(renderer);


        // Final Additive Blend to Screen or Write Buffer
        this.fsQuad.material = this.materialCopy;
        this.copyUniforms[ 'tDiffuse' ].value = this.renderTargetBright.texture; // The result of composited blurs

		if ( this.renderToScreen ) { // If this is the last pass, render to screen
            this.materialCopy.blending = THREE.AdditiveBlending; // Ensure additive
			renderer.setRenderTarget( null );
			this.fsQuad.render( renderer );
		} else { // Otherwise, render to the writeBuffer
            this.materialCopy.blending = THREE.AdditiveBlending; // Ensure additive
			renderer.setRenderTarget( writeBuffer );
            if(this.clear) renderer.clear();
			this.fsQuad.render( renderer );
		}


		// Restore Original State
		if ( maskActive ) renderer.state.buffers.stencil.setTest( true );
		renderer.setClearColor( this._oldClearColor, this.oldClearAlpha );
		renderer.autoClear = oldAutoClear;
	}
}

UnrealBloomPass.BlurDirectionX = new THREE.Vector2( 1.0, 0.0 );
UnrealBloomPass.BlurDirectionY = new THREE.Vector2( 0.0, 1.0 );

export { UnrealBloomPass };

    