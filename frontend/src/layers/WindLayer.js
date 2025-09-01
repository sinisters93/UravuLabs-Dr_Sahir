import { Layer } from "@deck.gl/core";
import { GL } from "@luma.gl/constants";
import { Model, Geometry } from "@luma.gl/engine";

export default class WindLayer extends Layer {
  initializeState() {
    const numParticles = this.props.numParticles || 500;
    const particles = new Array(numParticles).fill().map(() => ({
      lon: Math.random() * 360 - 180,
      lat: Math.random() * 180 - 90,
    }));
    this.setState({ particles });
  }

  getShaders() {
    return {
      vs: `
        attribute vec3 positions;
        void main(void) {
          gl_Position = vec4(positions, 1.0);
          gl_PointSize = 8.0;   // ✅ bigger dots
        }
      `,
      fs: `
        precision highp float;
        void main(void) {
          gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0); // ✅ bright red
        }
      `,
    };
  }

  updateParticles() {
    const { particles } = this.state;
    particles.forEach((p) => {
      // random bouncing motion
      p.lon += (Math.random() - 0.5) * 2;
      p.lat += (Math.random() - 0.5) * 2;

      // wrap around globe
      if (p.lon > 180) p.lon -= 360;
      if (p.lon < -180) p.lon += 360;
      if (p.lat > 90) p.lat = -90;
      if (p.lat < -90) p.lat = 90;
    });
  }

  draw({ uniforms }) {
    this.updateParticles();

    const positions = new Float32Array(this.state.particles.length * 3);
    this.state.particles.forEach((p, i) => {
      const x = ((p.lon + 180) / 360) * 2 - 1;
      const y = ((90 - p.lat) / 180) * 2 - 1;
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = 0;
    });

    if (!this.state.model) {
      this.setState({
        model: new Model(this.context.gl, {
          id: this.props.id,
          vs: this.getShaders().vs,
          fs: this.getShaders().fs,
          geometry: new Geometry({
            drawMode: GL.POINTS,
            attributes: {
              positions: { size: 3, value: positions },
            },
          }),
        }),
      });
    } else {
      this.state.model.setAttributes({
        positions: { size: 3, value: positions },
      });
      this.state.model.draw({ uniforms });
    }
  }
}
