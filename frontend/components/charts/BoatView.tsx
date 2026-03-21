import { createEffect, createSignal } from "solid-js";
import * as THREE from "three";

function BoatView() {
  let container: HTMLElement | null = null;
  const [scene] = createSignal(new THREE.Scene());
  const [camera] = createSignal(new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 1000));
  const [renderer] = createSignal(new THREE.WebGLRenderer());
  
  // Replace cube with a rectangle (boat representation)
  const [boat] = createSignal(new THREE.Mesh(
    new THREE.BoxGeometry(4, 0.5, 1), // Length: 4, Height: 0.5, Width: 1 (boat-like proportions)
    new THREE.MeshBasicMaterial({ color: 0x4169E1 }) // Royal blue color
  ));

  createEffect(() => {
    if (!container) return;
    
    // Get container dimensions instead of window dimensions
    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight - 50;
    
    renderer().setSize(containerWidth, containerHeight);
    container.appendChild(renderer().domElement);

    // Update camera aspect ratio to match container
    camera().aspect = containerWidth / containerHeight;
    camera().updateProjectionMatrix();

    // Add boat to scene
    scene().add(boat());

    // Create a group to hold both the boat and axes together
    const boatGroup = new THREE.Group();
    boatGroup.add(boat());

    // Create custom arrow helpers attached to the boat
    const arrowHelper1 = new THREE.ArrowHelper(
      new THREE.Vector3(1, 0, 0), // X-axis direction (red) - along boat length
      new THREE.Vector3(0, 0, 0), // Origin
      3, // Length to extend beyond boat
      0xff0000 // Red color
    );
    
    const arrowHelper2 = new THREE.ArrowHelper(
      new THREE.Vector3(0, 1, 0), // Y-axis direction (green) - up from boat
      new THREE.Vector3(0, 0, 0), // Origin
      2, // Length
      0x00ff00 // Green color
    );
    
    const arrowHelper3 = new THREE.ArrowHelper(
      new THREE.Vector3(0, 0, 1), // Z-axis direction (blue) - across boat width
      new THREE.Vector3(0, 0, 0), // Origin
      2, // Length
      0x0000ff // Blue color
    );

    // Add arrows to the boat group so they rotate together
    boatGroup.add(arrowHelper1);
    boatGroup.add(arrowHelper2);
    boatGroup.add(arrowHelper3);

    // Add the group to the scene instead of individual objects
    scene().add(boatGroup);

    // Set camera position for better view
    camera().position.set(5, 5, 5);
    camera().lookAt(0, 0, 0);

    function animate() {
      // Rotate the entire boat group (boat + axes together)
      boatGroup.rotation.y += 0.01;
      renderer().render(scene(), camera());
      requestAnimationFrame(animate);
    }

    animate();
  });

  return <div ref={el => (container = el)} style={{ width: "100%", height: "100%" }}></div>;
}

export default BoatView;

