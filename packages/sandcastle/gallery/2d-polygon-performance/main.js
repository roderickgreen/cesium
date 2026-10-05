// @ts-nocheck

import * as Cesium from "cesium";
import Sandcastle from "Sandcastle";

// Reproduces https://github.com/CesiumGS/cesium/issues/5026
//
// In 2D the depth range of the scene is split into frustums at the heights in
// scene.frustumBoundaries2D, and every draw command is executed once per
// frustum its bounding volume overlaps. Entity polygons are batched into a few
// primitives with one bounding sphere each, so a single huge polygon in a batch
// makes every polygon in that batch pay for all of the frustums.
//
// The scene draws two small concentric circles around Vienna one separation
// step apart in height, with thousands of outlined, overlapping parcel polygons
// packed inside the inner circle. Each parcel's color says how many steps it
// sits above the inner circle (see parcelColors), so where the depth precision
// is fine enough every overlap shows the higher color on top, and where it is
// too coarse the colors flicker into each other while panning.
// Fills and outlines are one command each. On their own the circles need a single frustum.
// Drawing the same circles as markers at other cities puts them all in one
// batch, whose bounding sphere then spans the whole dataset. In the original code the depth
// range was sliced into uniform 1,750 km frustums, so the number of frustums
// was about ceil(r / 1.75e6) + 1 for a sphere radius r above the map plane
// (1 degree is about 111 km in both map directions): Europe-wide data needed
// 3 to 4 frustums and 9 took a radius above 12,250 km, for example Vienna,
// Tokyo and Los Angeles together.
//
// Pick a preset or edit the boundaries directly. Depth within a frustum is
// resolved in 24 bits, so a frustum d meters deep separates layers about
// d / 16,777,216 meters apart, roughly 10 cm for 1,750 km:
//   Default: the map plane and everything up to 1,500 km above it share one
//      1,750 km deep frustum; anything higher is in a second frustum.
//   Fine: a 20 km deep frustum around the plane resolves millimeters.
//   Fine + coarse: the same 20 km frustum, then a 1,750 km frustum keeping
//      10 cm up to 1,760 km, then one frustum for everything higher.
//   Original: uniform 1,750 km slabs all the way up; slow with big volumes.
//   Single: no boundaries, one frustum for the whole depth range. The deeper
//      the frustum the coarser the depth, so layers closer together than that
//      vanish or flicker while panning. Try markers at Tokyo and Los Angeles
//      with 10 cm separation and zoom out.

const viewer = new Cesium.Viewer("cesiumContainer", {
  sceneMode: Cesium.SceneMode.SCENE2D,
  // mapMode2D defaults to INFINITE_SCROLL, which is the mode that exhibits the issue.
});
const scene = viewer.scene;
const camera = viewer.camera;
scene.debugShowFramesPerSecond = true;

// Vienna, the area covered by the GeoJSON attached to the issue.
const centerLongitude = 16.37;
const centerLatitude = 48.2;
const packedRectangle = Cesium.Rectangle.fromDegrees(16.2, 48.1, 16.55, 48.3);

// With the "Original" boundaries height 0 lies exactly between two frustums,
// so start a bit above it to keep every layer inside the same frustum.
const baseHeight = 10.0;

// The inner circle just encloses the packed polygons; the outer one stays
// visible when zoomed out to a country or continent.
const innerRadius = 2.0e4;
const outerRadius = 1.5e5;

const cities = {
  Vienna: [centerLongitude, centerLatitude],
  Lisbon: [-9.14, 38.72],
  Athens: [23.73, 37.98],
  Moscow: [37.62, 55.75],
  Reykjavik: [-21.94, 64.15],
  Honolulu: [-157.86, 21.31],
  Tokyo: [139.69, 35.69],
  "Los Angeles": [-118.24, 34.05],
};
// Expected frustums with the original code: 1, 3, 4, 7 and 9.
const citySets = {
  None: [],
  "Lisbon, Athens, Moscow": ["Lisbon", "Athens", "Moscow"],
  "Europe + Reykjavik": ["Lisbon", "Athens", "Moscow", "Reykjavik"],
  Honolulu: ["Honolulu"],
  "Tokyo, Los Angeles": ["Tokyo", "Los Angeles"],
};
const separations = {
  "1 cm": 0.01,
  "10 cm": 0.1,
  "25 cm": 0.25,
  "50 cm": 0.5,
  "1 m": 1.0,
  "2 m": 2.0,
};
// Parcel fill colors, lowest first: a parcel of the i-th color is drawn i + 1
// separation steps above the inner circle. Two overlapping parcels of the same
// color are coplanar and z-fight at any precision, but they are the same color
// so that fight is invisible; every visible fight is a precision failure.
const parcelColors = [
  Cesium.Color.RED,
  Cesium.Color.YELLOW,
  Cesium.Color.LIME,
  Cesium.Color.CYAN,
  Cesium.Color.MAGENTA,
  Cesium.Color.WHITE,
];
let otherCities = citySets["Tokyo, Los Angeles"];
let heightStep = separations["25 cm"];
let polygonCount = 5000;
let outlines = true;

function addCircle(city, radius, height, color) {
  viewer.entities.add({
    position: Cesium.Cartesian3.fromDegrees(city[0], city[1]),
    ellipse: {
      semiMajorAxis: radius,
      semiMinorAxis: radius,
      height: height,
      material: color,
      outline: outlines,
      outlineColor: Cesium.Color.BLACK,
    },
  });
}

// Parcel-like polygons: eight jittered vertices around a center, an opaque
// per-feature fill color and a black outline, like GeoJSON simplestyle data.
// The fills of all polygons and circles are drawn by one command, and all of
// their outlines by another, so each command is executed once per frustum.
function addParcel(longitude, latitude, size, height, color) {
  const positions = [];
  for (let i = 0; i < 8; ++i) {
    const angle = (i / 8) * Cesium.Math.TWO_PI;
    const distance = size * (0.35 + 0.15 * Cesium.Math.nextRandomNumber());
    positions.push(
      longitude + distance * Math.cos(angle),
      latitude + distance * Math.sin(angle),
    );
  }
  viewer.entities.add({
    polygon: {
      hierarchy: Cesium.Cartesian3.fromDegreesArray(positions),
      height: height,
      material: color,
      outline: outlines,
      outlineColor: Cesium.Color.BLACK,
    },
  });
}

// Small polygons packed onto the center of the circles. The polygon size shrinks
// with the count so the same area stays densely covered. Parcels overlap, and
// each one gets a random color from parcelColors and the height that color
// stands for, one to parcelColors.length separation steps above the given
// height. Uses the seeded random number generator so the scene is the same on
// every load.
function addPackedPolygons(count, height) {
  Cesium.Math.setRandomNumberSeed(0);
  const west = Cesium.Math.toDegrees(packedRectangle.west);
  const south = Cesium.Math.toDegrees(packedRectangle.south);
  const width = Cesium.Math.toDegrees(packedRectangle.width);
  const extent = Cesium.Math.toDegrees(packedRectangle.height);
  const size = Math.sqrt((width * extent) / count);
  for (let i = 0; i < count; ++i) {
    const level = Math.floor(
      Cesium.Math.nextRandomNumber() * parcelColors.length,
    );
    addParcel(
      west + size / 2 + (width - size) * Cesium.Math.nextRandomNumber(),
      south + size / 2 + (extent - size) * Cesium.Math.nextRandomNumber(),
      size,
      height + heightStep * (level + 1),
      parcelColors[level],
    );
  }
}

function rebuild() {
  viewer.entities.suspendEvents();
  viewer.entities.removeAll();
  const names = ["Vienna"].concat(otherCities);
  for (let i = 0; i < names.length; ++i) {
    const city = cities[names[i]];
    addCircle(city, outerRadius, baseHeight, Cesium.Color.DARKORANGE);
    addCircle(
      city,
      innerRadius,
      baseHeight + heightStep,
      Cesium.Color.STEELBLUE,
    );
  }
  addPackedPolygons(polygonCount, baseHeight + heightStep);
  viewer.entities.resumeEvents();
}

// Presets for scene.frustumBoundaries2D, and a text field to edit it directly.
const uniformSlabs = [];
for (let z = -1.75e6; z <= 2.1e7; z += 1.75e6) {
  uniformSlabs.push(z);
}
const boundaryPresets = {
  "Default: -250 km, 1,500 km": [-2.5e5, 1.5e6],
  "Fine: -10 km, 10 km": [-1.0e4, 1.0e4],
  "Fine + coarse: -10 km, 10 km, 1,760 km": [-1.0e4, 1.0e4, 1.76e6],
  "Original: 1,750 km slabs": uniformSlabs,
  "Single frustum: none": [],
};

const boundariesInput = document.getElementById("frustumBoundaries");

function showBoundaries() {
  boundariesInput.value = JSON.stringify(scene.frustumBoundaries2D ?? []);
  boundariesInput.classList.remove("invalid");
}

function parseBoundaries(text) {
  const boundaries = JSON.parse(text);
  if (!Array.isArray(boundaries)) {
    throw new Error("not an array");
  }
  for (let i = 0; i < boundaries.length; ++i) {
    if (
      typeof boundaries[i] !== "number" ||
      !isFinite(boundaries[i]) ||
      (i > 0 && boundaries[i] <= boundaries[i - 1])
    ) {
      throw new Error("not ascending finite numbers");
    }
  }
  return boundaries;
}

boundariesInput.addEventListener("change", function () {
  try {
    scene.frustumBoundaries2D = parseBoundaries(boundariesInput.value);
    showBoundaries();
  } catch (error) {
    boundariesInput.classList.add("invalid");
  }
});

Sandcastle.addToolbarMenu(
  Object.keys(boundaryPresets).map(function (name) {
    return {
      text: name,
      onselect: function () {
        scene.frustumBoundaries2D = boundaryPresets[name].slice();
        showBoundaries();
      },
    };
  }),
  "frustumsField",
);
showBoundaries();

// Registered first so that Sandcastle runs this, rather than the first option
// of the first menu, as the default action when the demo finishes loading.
Sandcastle.addDefaultToolbarButton(
  "Zoom to polygons",
  function () {
    camera.setView({ destination: packedRectangle });
  },
  "zoomButtons",
);

function addMenu(prefix, values, selected, onselect) {
  Sandcastle.addToolbarMenu(
    Object.keys(values).map(function (name) {
      return {
        text: `${prefix}: ${name}`,
        value: name,
        onselect: function () {
          onselect(values[name]);
          rebuild();
        },
      };
    }),
  );
  const menus = document.querySelectorAll("#toolbar select");
  menus[menus.length - 1].value = selected;
}

addMenu("Markers at", citySets, "Tokyo, Los Angeles", (value) => {
  otherCities = value;
});
addMenu("Layer separation", separations, "25 cm", (value) => {
  heightStep = value;
});
addMenu(
  "Polygons",
  { "5,000": 5000, "10,000": 10000, "20,000": 20000, "50,000": 50000 },
  "5,000",
  (value) => {
    polygonCount = value;
  },
);

Sandcastle.addToggleButton("Outlines", outlines, function (checked) {
  outlines = checked;
  rebuild();
});

// Legend: each color with the number of separation steps it sits above the
// outer circle.
const legend = document.createElement("div");
legend.id = "legend";
legend.innerHTML = [
  ["darkorange", "outer"],
  ["steelblue", "inner +1"],
]
  .concat(
    parcelColors.map(function (color, index) {
      return [color.toCssColorString(), `+${index + 2}`];
    }),
  )
  .map(function (entry) {
    return `<span><i style="background:${entry[0]}"></i>${entry[1]}</span>`;
  })
  .join("");
document.getElementById("toolbar").appendChild(legend);

// Overlay with the multifrustum statistics for the last rendered frame: a
// summary line and a table with one row per frustum, highest first.
const stats = document.createElement("div");
stats.id = "stats";
stats.innerHTML =
  '<div id="statsSummary"></div>' +
  '<div id="frustumTableWrapper"><table id="frustumTable">' +
  "<thead><tr><th>#</th><th>from km</th><th>to km</th><th>cmds</th><th>step</th></tr></thead>" +
  "<tbody></tbody></table></div>";
document.getElementById("toolbar").appendChild(stats);
const statsSummary = stats.querySelector("#statsSummary");
const frustumTableBody = stats.querySelector("tbody");
let lastStats;

function formatStep(meters) {
  if (meters >= 1.0) {
    return `${meters.toFixed(2)} m`;
  }
  if (meters >= 0.01) {
    return `${(meters * 100.0).toFixed(1)} cm`;
  }
  return `${(meters * 1000.0).toFixed(2)} mm`;
}

scene.postRender.addEventListener(function () {
  const frustumCommandsList = scene.frustumCommandsList;
  const cameraHeight = camera.position.z;
  const km = (meters) => (meters / 1000.0).toFixed(0);

  // Depth within a frustum is stored in a 24-bit depth buffer, so the smallest
  // height difference a frustum can tell apart is its depth divided by 2^24.
  // Frustums are ordered near to far, which in 2D is highest first. The row
  // whose height range contains the map plane is highlighted.
  const rows = frustumCommandsList.map(function (frustumCommands, index) {
    let commands = 0;
    for (let i = 0; i < frustumCommands.indices.length; ++i) {
      commands += frustumCommands.indices[i];
    }
    const bottom = cameraHeight - frustumCommands.far;
    const top = cameraHeight - frustumCommands.near;
    const step = (frustumCommands.far - frustumCommands.near) / 16777216.0;
    const className = bottom <= 0.0 && top >= 0.0 ? ' class="plane"' : "";
    return (
      `<tr${className}><td>${index}</td><td>${km(bottom)}</td>` +
      `<td>${km(top)}</td><td>${commands}</td><td>${formatStep(step)}</td></tr>`
    );
  });

  // The largest bounding sphere of any entity draw command, which is what
  // decides how many frustums the batch overlaps. Only the OPAQUE and
  // TRANSLUCENT passes are inspected so the map tiles in the GLOBE pass do
  // not count.
  let maxRadius = 0.0;
  for (let f = 0; f < frustumCommandsList.length; ++f) {
    const frustumCommands = frustumCommandsList[f];
    for (const pass of [Cesium.Pass.OPAQUE, Cesium.Pass.TRANSLUCENT]) {
      const commands = frustumCommands.commands[pass];
      const count = frustumCommands.indices[pass];
      for (let i = 0; i < count; ++i) {
        const boundingVolume = commands[i].boundingVolume;
        if (
          Cesium.defined(boundingVolume) &&
          boundingVolume.radius > maxRadius
        ) {
          maxRadius = boundingVolume.radius;
        }
      }
    }
  }

  const summary =
    `camera at ${km(cameraHeight)} km\n` +
    `bounding sphere radius ${km(maxRadius)} km\n` +
    `${frustumCommandsList.length} frustums`;
  const html = rows.join("");
  if (summary + html !== lastStats) {
    lastStats = summary + html;
    statsSummary.textContent = summary;
    frustumTableBody.innerHTML = html;
  }
});

camera.setView({ destination: packedRectangle });
rebuild();
