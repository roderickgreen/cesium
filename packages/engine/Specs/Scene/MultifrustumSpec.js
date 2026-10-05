import {
  BoundingSphere,
  BoxGeometry,
  Cartesian2,
  Cartesian3,
  Color,
  GeometryPipeline,
  Math as CesiumMath,
  Matrix4,
  defined,
  destroyObject,
} from "@cesium/core";
import {
  Resource,
  BufferUsage,
  DrawCommand,
  Pass,
  RenderState,
  Sampler,
  ShaderProgram,
  VertexArray,
  BillboardCollection,
  BlendingState,
  SceneMode,
  TextureAtlas,
} from "../../index.js";
import createScene from "../../../../Specs/createScene.js";
import pollToPromise from "../../../../Specs/pollToPromise.js";

describe(
  "Scene/Multifrustum",
  function () {
    let scene;
    let primitives;
    let atlas;

    let greenImage;
    let blueImage;
    let whiteImage;

    let logDepth;

    beforeAll(function () {
      scene = createScene();
      logDepth = scene.logarithmicDepthBuffer;
      scene.destroyForSpecs();

      return Promise.all([
        Resource.fetchImage("./Data/Images/Green.png").then(function (image) {
          greenImage = image;
        }),
        Resource.fetchImage("./Data/Images/Blue.png").then(function (image) {
          blueImage = image;
        }),
        Resource.fetchImage("./Data/Images/White.png").then(function (image) {
          whiteImage = image;
        }),
      ]);
    });

    beforeEach(function () {
      scene = createScene();
      primitives = scene.primitives;

      scene.logarithmicDepthBuffer = false;

      const camera = scene.camera;
      camera.position = new Cartesian3();
      camera.direction = Cartesian3.negate(Cartesian3.UNIT_Z, new Cartesian3());
      camera.up = Cartesian3.clone(Cartesian3.UNIT_Y);
      camera.right = Cartesian3.clone(Cartesian3.UNIT_X);

      camera.frustum.near = 1.0;
      camera.frustum.far = 1000000000.0;
      camera.frustum.fov = CesiumMath.toRadians(60.0);
      camera.frustum.aspectRatio = 1.0;
    });

    afterEach(function () {
      atlas = atlas && atlas.destroy();
      scene.destroyForSpecs();
    });

    let billboard0;
    let billboard1;
    let billboard2;

    function createBillboards() {
      atlas = new TextureAtlas({
        borderWidthInPixels: 1,
        initialSize: new Cartesian2(3, 3),
        // ANGLE workaround
        sampler: Sampler.NEAREST,
      });
      let billboards = new BillboardCollection({
        textureAtlas: atlas,
      });
      billboards.destroyTextureAtlas = false;
      billboard0 = billboards.add({
        position: new Cartesian3(0.0, 0.0, -50.0),
        image: greenImage,
      });
      primitives.add(billboards);

      billboards = new BillboardCollection();
      billboards.textureAtlas = atlas;
      billboards.destroyTextureAtlas = false;
      billboard1 = billboards.add({
        position: new Cartesian3(0.0, 0.0, -50000.0),
        image: blueImage,
      });
      primitives.add(billboards);

      billboards = new BillboardCollection();
      billboards.textureAtlas = atlas;
      billboards.destroyTextureAtlas = false;
      billboard2 = billboards.add({
        position: new Cartesian3(0.0, 0.0, -50000000.0),
        image: whiteImage,
      });
      primitives.add(billboards);

      return pollToPromise(function () {
        scene.renderForSpecs();
        return billboard0.ready && billboard1.ready && billboard2.ready;
      });
    }

    it("renders primitive in closest frustum", function () {
      return createBillboards().then(function () {
        expect(scene).toRenderAndCall(function (rgba) {
          expect(rgba[0]).toEqual(0);
          expect(rgba[1]).not.toEqual(0);
          expect(rgba[2]).toEqual(0);
          expect(rgba[3]).toEqual(255);
        });

        expect(scene).toRenderAndCall(function (rgba) {
          expect(rgba[0]).toEqual(0);
          expect(rgba[1]).not.toEqual(0);
          expect(rgba[2]).toEqual(0);
          expect(rgba[3]).toEqual(255);
        });
      });
    });

    it("renders primitive in middle frustum", function () {
      return createBillboards().then(function () {
        billboard0.color = new Color(1.0, 1.0, 1.0, 0.0);

        expect(scene).toRender([0, 0, 255, 255]);
        expect(scene).toRender([0, 0, 255, 255]);
      });
    });

    it("renders primitive in last frustum", function () {
      return createBillboards().then(function () {
        const color = new Color(1.0, 1.0, 1.0, 0.0);
        billboard0.color = color;
        billboard1.color = color;

        expect(scene).toRender([255, 255, 255, 255]);
        expect(scene).toRender([255, 255, 255, 255]);
      });
    });

    it("renders primitive in last frustum with debugShowFrustums", function () {
      return createBillboards().then(function () {
        const color = new Color(1.0, 1.0, 1.0, 1.0);
        billboard0.color = color;
        billboard1.color = color;

        spyOn(DrawCommand.prototype, "execute");

        scene.debugShowFrustums = true;
        scene.renderForSpecs();

        expect(DrawCommand.prototype.execute).toHaveBeenCalled();

        const calls = DrawCommand.prototype.execute.calls.all();
        let billboardCall;
        let i;
        for (i = 0; i < calls.length; ++i) {
          if (calls[i].object.owner instanceof BillboardCollection) {
            billboardCall = calls[i];
            break;
          }
        }

        expect(billboardCall).toBeDefined();
        expect(billboardCall.args.length).toEqual(2);

        let found = false;
        const sources =
          billboardCall.object.shaderProgram.fragmentShaderSource.sources;
        for (let j = 0; j < sources.length; ++j) {
          if (sources[j].indexOf("czm_Debug_main") !== -1) {
            found = true;
            break;
          }
        }
        expect(found).toBe(true);
      });
    });

    function createPrimitive(
      bounded,
      closestFrustum,
      boundingSphereRadius,
      boundingSphereCenter,
    ) {
      bounded = bounded ?? true;
      closestFrustum = closestFrustum ?? false;
      boundingSphereRadius = boundingSphereRadius ?? 500000.0;
      boundingSphereCenter = boundingSphereCenter ?? Cartesian3.ZERO;

      function Primitive() {
        this._va = undefined;
        this._sp = undefined;
        this._rs = undefined;
        this._modelMatrix = Matrix4.fromTranslation(
          new Cartesian3(0.0, 0.0, -50000.0),
          new Matrix4(),
        );

        this.color = new Color(1.0, 1.0, 0.0, 1.0);

        const that = this;
        this._um = {
          u_color: function () {
            return that.color;
          },
          u_model: function () {
            return that._modelMatrix;
          },
        };
      }
      Primitive.prototype.update = function (frameState) {
        if (!defined(this._sp)) {
          const zUpdate = closestFrustum
            ? `gl_Position.z = clamp(gl_Position.z, gl_DepthRange.near, gl_DepthRange.far);`
            : ``;
          const vs = `
          in vec4 position;
          void main()
          {
              vec4 positionEC = czm_modelView * position;
              gl_Position = czm_projection * positionEC;
              ${zUpdate}
          }`;
          const fs = `
          uniform vec4 u_color;
          void main()
          {
              out_FragColor = u_color;
          }`;

          const dimensions = new Cartesian3(500000.0, 500000.0, 500000.0);
          const maximum = Cartesian3.multiplyByScalar(
            dimensions,
            0.5,
            new Cartesian3(),
          );
          const minimum = Cartesian3.negate(maximum, new Cartesian3());
          const geometry = BoxGeometry.createGeometry(
            new BoxGeometry({
              minimum: minimum,
              maximum: maximum,
            }),
          );
          const attributeLocations =
            GeometryPipeline.createAttributeLocations(geometry);
          this._va = VertexArray.fromGeometry({
            context: frameState.context,
            geometry: geometry,
            attributeLocations: attributeLocations,
            bufferUsage: BufferUsage.STATIC_DRAW,
          });

          this._sp = ShaderProgram.fromCache({
            context: frameState.context,
            vertexShaderSource: vs,
            fragmentShaderSource: fs,
            attributeLocations: attributeLocations,
          });

          this._rs = RenderState.fromCache({
            blending: BlendingState.ALPHA_BLEND,
          });
        }

        frameState.commandList.push(
          new DrawCommand({
            renderState: this._rs,
            shaderProgram: this._sp,
            vertexArray: this._va,
            uniformMap: this._um,
            modelMatrix: this._modelMatrix,
            executeInClosestFrustum: closestFrustum,
            boundingVolume: bounded
              ? new BoundingSphere(
                  Cartesian3.clone(boundingSphereCenter),
                  boundingSphereRadius,
                )
              : undefined,
            pass: Pass.OPAQUE,
          }),
        );
      };

      Primitive.prototype.destroy = function () {
        this._va = this._va && this._va.destroy();
        this._sp = this._sp && this._sp.destroy();
        return destroyObject(this);
      };

      Primitive.prototype.isDestroyed = () => {
        return false;
      };

      return new Primitive();
    }

    it("renders primitive with undefined bounding volume", function () {
      const primitive = createPrimitive(false);
      primitives.add(primitive);

      expect(scene).toRender([255, 255, 0, 255]);
      expect(scene).toRender([255, 255, 0, 255]);
    });

    it("renders only in the closest frustum", function () {
      return createBillboards().then(function () {
        const color = new Color(1.0, 1.0, 1.0, 0.0);
        billboard0.color = color;
        billboard1.color = color;
        billboard2.color = color;

        const primitive = createPrimitive(true, true);
        primitive.color = new Color(1.0, 1.0, 0.0, 0.5);
        primitives.add(primitive);

        expect(scene).toRenderAndCall(function (rgba) {
          expect(rgba[0]).not.toEqual(0);
          expect(rgba[1]).not.toEqual(0);
          expect(rgba[2]).toEqual(0);
          expect(rgba[3]).toEqual(255);
        });

        expect(scene).toRenderAndCall(function (rgba) {
          expect(rgba[0]).not.toEqual(0);
          expect(rgba[1]).not.toEqual(0);
          expect(rgba[2]).toEqual(0);
          expect(rgba[3]).toEqual(255);
        });
      });
    });

    it("render without a central body or any primitives", function () {
      scene.renderForSpecs();
    });

    function morphTo2D(cameraHeight) {
      // Move the camera to a valid position so the morph can project it to 2D.
      scene.camera.setView({
        destination: Cartesian3.fromDegrees(0.0, 0.0, 10000000.0),
      });
      scene.morphTo2D(0.0);
      expect(scene.mode).toEqual(SceneMode.SCENE2D);
      // In 2D the camera height is only used to place the frustums.
      scene.camera.position.z = cameraHeight;
    }

    function expectFrustumsToBeContiguous(frustumCommandsList) {
      expect(frustumCommandsList[0].near).toEqual(scene.camera.frustum.near);
      for (let i = 1; i < frustumCommandsList.length; ++i) {
        expect(frustumCommandsList[i].near).toEqual(
          frustumCommandsList[i - 1].far,
        );
      }
    }

    it("splits the depth range in 2D at the default frustum boundaries", function () {
      morphTo2D(1.0e7);
      // A bounding volume that reaches far above the map plane, like the bounding
      // sphere of a dataset spanning the whole map, must not slice the empty depth
      // above the plane into many frustums.
      primitives.add(createPrimitive(true, false, 2.0e7));
      scene.renderForSpecs();

      const boundaries = scene.frustumBoundaries2D;
      expect(boundaries).toEqual([-2.5e5, 1.5e6]);

      const height = scene.camera.position.z;
      const frustumCommandsList = scene.frustumCommandsList;
      expect(frustumCommandsList.length).toEqual(2);
      expectFrustumsToBeContiguous(frustumCommandsList);

      // The last frustum contains the map plane and lies between the two boundaries.
      const last = frustumCommandsList[1];
      expect(last.far).toEqualEpsilon(
        height - boundaries[0],
        CesiumMath.EPSILON7,
      );
      expect(last.near).toEqualEpsilon(
        height - boundaries[1],
        CesiumMath.EPSILON7,
      );
    });

    it("renders the whole depth range in 2D with one frustum without frustum boundaries", function () {
      morphTo2D(1.0e7);
      primitives.add(createPrimitive(true, false, 2.0e7));

      scene.frustumBoundaries2D = [];
      scene.renderForSpecs();
      expect(scene.frustumCommandsList.length).toEqual(1);
      // Without a lowest boundary the far plane is set by the farthest bounding volume.
      expect(scene.frustumCommandsList[0].far).toBeGreaterThan(
        scene.camera.position.z,
      );

      scene.frustumBoundaries2D = undefined;
      scene.renderForSpecs();
      expect(scene.frustumCommandsList.length).toEqual(1);
    });

    it("uses the configured frustum boundaries in 2D", function () {
      morphTo2D(1.0e7);
      primitives.add(createPrimitive(true, false, 2.0e7));

      // Uniform slicing of the depth range: one frustum between each pair of
      // boundaries, plus one from the highest boundary up to the nearest geometry.
      const boundaries = [-1.75e6, 0.0, 1.75e6, 3.5e6, 5.25e6];
      scene.frustumBoundaries2D = boundaries;
      scene.renderForSpecs();

      const height = scene.camera.position.z;
      const frustumCommandsList = scene.frustumCommandsList;
      const length = frustumCommandsList.length;
      expect(length).toEqual(boundaries.length);
      expectFrustumsToBeContiguous(frustumCommandsList);
      for (let i = 1; i < boundaries.length; ++i) {
        const frustumCommands = frustumCommandsList[length - i];
        expect(frustumCommands.far).toEqualEpsilon(
          height - boundaries[i - 1],
          CesiumMath.EPSILON7,
        );
        expect(frustumCommands.near).toEqualEpsilon(
          height - boundaries[i],
          CesiumMath.EPSILON7,
        );
      }
    });

    it("does not create frustums above the nearest geometry in 2D", function () {
      morphTo2D(1.0e7);
      // A bounding sphere reaching 2,000 kilometers above the map plane.
      primitives.add(createPrimitive(true, false, 2.0e6));

      scene.frustumBoundaries2D = [-1.75e6, 0.0, 1.75e6, 3.5e6, 2.0e7];
      scene.renderForSpecs();

      // Two frustums below 1,750 kilometers, one from there up to the sphere,
      // and none above it.
      const height = scene.camera.position.z;
      const frustumCommandsList = scene.frustumCommandsList;
      expect(frustumCommandsList.length).toEqual(3);
      expect(frustumCommandsList[0].near).toEqualEpsilon(
        height - 2.0e6,
        CesiumMath.EPSILON7,
      );
      expect(frustumCommandsList[0].far).toEqualEpsilon(
        height - 1.75e6,
        CesiumMath.EPSILON7,
      );
    });

    it("creates no frustums in 2D when there is nothing to draw", function () {
      morphTo2D(1.0e7);
      scene.renderForSpecs();
      expect(scene.frustumCommandsList.length).toEqual(0);
    });

    it("creates no frustums in 2D when all geometry is below the lowest boundary", function () {
      morphTo2D(1.0e7);
      // In 2D world coordinates the x axis is the height above the map plane.
      primitives.add(
        createPrimitive(true, false, 1.0e4, new Cartesian3(-5.0e5, 0.0, 0.0)),
      );
      scene.renderForSpecs();
      expect(scene.frustumCommandsList.length).toEqual(0);
    });

    it("creates no frustums in 2D when all boundaries are above the camera", function () {
      morphTo2D(5.0e5);
      primitives.add(createPrimitive(true, false, 1.0e5));
      scene.frustumBoundaries2D = [1.0e6, 2.0e6];
      scene.renderForSpecs();
      expect(scene.frustumCommandsList.length).toEqual(0);
    });

    it("does not create an empty frustum in 2D for geometry above the highest boundary", function () {
      morphTo2D(1.0e7);
      const center = new Cartesian3(5.0e6, 0.0, 0.0);
      primitives.add(createPrimitive(true, false, 1.0e5, center));
      scene.renderForSpecs();

      const height = scene.camera.position.z;
      const frustumCommandsList = scene.frustumCommandsList;
      expect(frustumCommandsList.length).toEqual(1);
      expect(frustumCommandsList[0].near).toEqualEpsilon(
        height - center.x - 1.0e5,
        CesiumMath.EPSILON7,
      );
      expect(frustumCommandsList[0].far).toBeGreaterThan(
        frustumCommandsList[0].near,
      );
      expect(frustumCommandsList[0].far).toBeLessThan(height);
    });

    it("skips boundaries in 2D that would create a frustum less than one meter deep", function () {
      morphTo2D(1.0e7);
      primitives.add(createPrimitive(true, false, 2.0e7));

      scene.frustumBoundaries2D = [-2.5e5, -2.5e5 + 0.5, 1.5e6, 1.5e6 + 0.5];
      scene.renderForSpecs();

      const height = scene.camera.position.z;
      const frustumCommandsList = scene.frustumCommandsList;
      expect(frustumCommandsList.length).toEqual(2);
      expectFrustumsToBeContiguous(frustumCommandsList);
      // Of two boundaries less than a meter apart the higher one is kept.
      expect(frustumCommandsList[1].near).toEqual(height - (1.5e6 + 0.5));
      // The frustum reaches the far plane rather than stopping half a meter short.
      expect(frustumCommandsList[1].far).toEqualEpsilon(
        height + 2.5e5,
        CesiumMath.EPSILON7,
      );
    });

    it("throws in 2D when the frustum boundaries are not ascending finite numbers", function () {
      morphTo2D(1.0e7);
      primitives.add(createPrimitive(true, false, 2.0e7));

      scene.frustumBoundaries2D = [1.0, 0.0];
      expect(function () {
        scene.renderForSpecs();
      }).toThrowDeveloperError();

      scene.frustumBoundaries2D = [0.0, Number.NaN];
      expect(function () {
        scene.renderForSpecs();
      }).toThrowDeveloperError();

      scene.frustumBoundaries2D = 1.0e6;
      expect(function () {
        scene.renderForSpecs();
      }).toThrowDeveloperError();
    });

    it("sets the frustum boundaries in 2D from the deprecated nearToFarDistance2D", function () {
      scene.nearToFarDistance2D = 1.0e6;
      expect(scene.nearToFarDistance2D).toEqual(1.0e6);
      expect(scene.frustumBoundaries2D).toEqual([-1.0e6, 0.0, 1.0e6]);
    });

    it("does not crash when near plane is greater than or equal to the far plane", function () {
      const camera = scene.camera;
      camera.frustum.far = 1000.0;
      camera.position = new Cartesian3(0.0, 0.0, 1e12);

      return createBillboards();
    });

    it("log depth uses less frustums", function () {
      if (!logDepth) {
        return;
      }

      return createBillboards().then(function () {
        scene.render();
        expect(scene.frustumCommandsList.length).toEqual(3);

        scene.logarithmicDepthBuffer = true;
        scene.render();
        expect(scene.frustumCommandsList.length).toEqual(1);
      });
    });
  },
  "WebGL",
);
