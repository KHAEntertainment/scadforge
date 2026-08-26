// Parses a 3MF (zip + XML) file's first mesh object into vertProperties /
// triVerts. Supported by validate.mjs for comparison, but NOT the
// recommended production input path -- see the README's INPUT FORMAT
// DECISION. Uses jszip (zip) + fast-xml-parser (XML), ~2.2MB combined,
// evaluated specifically for this decision.
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';

export async function parse3mf(buf) {
  const zip = await JSZip.loadAsync(buf);
  const modelFile = zip.file('3D/3dmodel.model');
  if (!modelFile) {
    throw new Error('3MF missing 3D/3dmodel.model entry');
  }
  const xml = await modelFile.async('string');
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });
  const doc = parser.parse(xml);

  const objects = doc.model.resources.object;
  const firstObject = Array.isArray(objects) ? objects[0] : objects;
  const mesh = firstObject.mesh;

  const vertexList = Array.isArray(mesh.vertices.vertex) ? mesh.vertices.vertex : [mesh.vertices.vertex];
  const triangleList = Array.isArray(mesh.triangles.triangle) ? mesh.triangles.triangle : [mesh.triangles.triangle];

  const vertProperties = new Float32Array(vertexList.length * 3);
  vertexList.forEach((v, i) => {
    vertProperties[i * 3] = parseFloat(v.x);
    vertProperties[i * 3 + 1] = parseFloat(v.y);
    vertProperties[i * 3 + 2] = parseFloat(v.z);
  });

  const triVerts = new Uint32Array(triangleList.length * 3);
  triangleList.forEach((t, i) => {
    triVerts[i * 3] = parseInt(t.v1, 10);
    triVerts[i * 3 + 1] = parseInt(t.v2, 10);
    triVerts[i * 3 + 2] = parseInt(t.v3, 10);
  });

  return {
    numProp: 3,
    vertProperties,
    triVerts,
    rawTriangleCount: triangleList.length,
    weldedVertexCount: vertexList.length,
  };
}
