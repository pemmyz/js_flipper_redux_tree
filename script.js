document.addEventListener('DOMContentLoaded', () => {
    // --- Configuration ---
    const CONFIG = {
        pixelsPerMeter: 30, // Physics scale
        canvasWidth: 600,
        canvasHeight: 1000, // Changed from 800
        gravity: 15,
        colors: {
            floor: 0x222222,
            wall: 0x00d2ff,
            wallLight: 0xeeeeee,
            ball: 0xffffff,
            flipper: 0xff0055,
            bumper: 0xf9a602,
            obstacle: 0x00ff88
        }
    };

    // --- Planck.js Setup ---
    const pl = planck;
    const Vec2 = pl.Vec2;
    let world;

    // --- Three.js Setup ---
    const container = document.getElementById('canvas-wrapper');
    const scene = new THREE.Scene();
    
    // Camera Setup for 2.5D View
    // We map physics width (approx 20 meters) to camera view
    const aspect = CONFIG.canvasWidth / CONFIG.canvasHeight;
    const viewSize = 30; // Vertical field of view in world units
    const camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 1000);
    
    // Position camera: Center X, Above Y, Back Z
    // Physics center is approx (10, 13). 
    // In 3D: X=Horizontal, Y=Vertical(Height), Z=Depth(Physics Y)
    // Actually, let's map: Physics X -> 3D X, Physics Y -> 3D Z. 3D Y is "Up".
    const midX = (CONFIG.canvasWidth / CONFIG.pixelsPerMeter) / 2;
    const midZ = (CONFIG.canvasHeight / CONFIG.pixelsPerMeter) / 2;
    
    camera.position.set(midX, 45, midZ + 30); // Moved camera higher (Y=45) and further back (Z+30) to fit 1000px height

    camera.lookAt(midX, 0, midZ); // Look at center of board

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(CONFIG.canvasWidth, CONFIG.canvasHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    // --- Lights ---
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(10, 30, 10);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.camera.near = 0.5;
    dirLight.shadow.camera.far = 100;
    dirLight.shadow.camera.left = -15;
    dirLight.shadow.camera.right = 15;
    dirLight.shadow.camera.top = 15;
    dirLight.shadow.camera.bottom = -15;
    scene.add(dirLight);

    // Spotlight for dramatic effect on the launcher area
    const spotLight = new THREE.SpotLight(0xff0055, 0.5);
    spotLight.position.set(midX + 5, 10, midZ + 10);
    spotLight.lookAt(midX + 5, 0, midZ + 10);
    scene.add(spotLight);

    // --- UI Elements ---
    const scoreEl = document.getElementById('score');
    const attemptsEl = document.getElementById('attempts');
    const gameOverScreen = document.getElementById('game-over-screen');
    const finalScoreEl = document.getElementById('final-score');
    const restartButton = document.getElementById('restart-button');
    const helpLegend = document.getElementById('help-legend');
    const closeHelpButton = document.getElementById('close-help-button');
    const muteButton = document.getElementById('mute-button');
    const gapButton = document.getElementById('gap-button');
    const helpToggleButton = document.getElementById('help-toggle-button');
    const themeToggleButton = document.getElementById('theme-toggle-button');
    const botStatusText = document.getElementById('bot-status-text');

    // --- Game State ---
    let score = 0;
    let ballsLeft = 3;
    let gameState = 'launch';
    let showHelp = false;
    let isMuted = false;
    
    let botModeActive = false;
    let botActivationTimer = null;
    let botCountdownInterval = null;
    let botLaunchTimerId = null;
    let botLeftFlipperHoldFrames = 0;
    let botRightFlipperHoldFrames = 0;
    const BOT_FLIPPER_HOLD_DURATION_FRAMES = 15;

    const BALL_RADIUS_PX = 10;
    const CHUTE_WIDTH_PX = 50;
    const PLAYFIELD_WIDTH_PX = CONFIG.canvasWidth - CHUTE_WIDTH_PX;
    
    // Physics Logic Variables
    let flipperGapBetweenTips = (BALL_RADIUS_PX * 2 + 5) + (BALL_RADIUS_PX / 2);
    let launcher = {};
    let leftFlipper = {};
    let rightFlipper = {};
    
    // Arrays to track sync
    let syncableObjects = []; // { body, mesh, type }
    let ballsToRemove = [];

    // --- Helpers ---
    const px2m = (px) => px / CONFIG.pixelsPerMeter;
    const m2px = (m) => m * CONFIG.pixelsPerMeter;

    // --- Audio ---
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    function unlockAudio() { if (audioCtx && audioCtx.state === 'suspended') { audioCtx.resume(); } }
    
    function playSound(type, volume = 0.3) {
        if (isMuted || !audioCtx) return;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        gain.gain.setValueAtTime(volume, audioCtx.currentTime);

        const now = audioCtx.currentTime;
        if (type === 'launch'){
            osc.type = 'sine'; osc.frequency.setValueAtTime(200, now);
            osc.frequency.linearRampToValueAtTime(800, now + 0.1);
            gain.gain.exponentialRampToValueAtTime(0.01, now + 0.5);
            osc.start(now); osc.stop(now + 0.5);
        } else if (type === 'bounce'){
            osc.type = 'square'; osc.frequency.setValueAtTime(400 + Math.random()*200, now);
            gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
            osc.start(now); osc.stop(now + 0.1);
        } else if (type === 'flipper'){
            osc.type = 'sawtooth'; osc.frequency.setValueAtTime(100, now);
            gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
            osc.start(now); osc.stop(now + 0.1);
        } else if (type === 'lose'){
            osc.type = 'triangle'; osc.frequency.setValueAtTime(200, now);
            osc.frequency.linearRampToValueAtTime(50, now + 1.0);
            gain.gain.exponentialRampToValueAtTime(0.01, now + 1.0);
            osc.start(now); osc.stop(now + 1.0);
        }
    }

    // --- 3D Helper Functions ---
    function create3DMesh(geometry, color, x, z, y = 0, castShadow = true) {
        const material = new THREE.MeshStandardMaterial({ 
            color: color, 
            roughness: 0.4, 
            metalness: 0.6 
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(x, y, z);
        if (castShadow) mesh.castShadow = true;
        mesh.receiveShadow = true;
        scene.add(mesh);
        return mesh;
    }

    function cleanupScene() {
        // Remove all meshes that are dynamic or part of the playfield
        for (let i = scene.children.length - 1; i >= 0; i--) {
            const child = scene.children[i];
            if (child.isMesh || child.isGroup) {
                // Keep lights, remove objects
                scene.remove(child);
            }
        }
        syncableObjects = [];
        ballsToRemove = [];
    }

    function createFloor() {
        const floorGeo = new THREE.PlaneGeometry(px2m(CONFIG.canvasWidth), px2m(CONFIG.canvasHeight));
        const floorMat = new THREE.MeshStandardMaterial({ 
            color: CONFIG.colors.floor, 
            roughness: 0.8,
            metalness: 0.2
        });
        const floor = new THREE.Mesh(floorGeo, floorMat);
        floor.rotation.x = -Math.PI / 2;
        floor.position.set(midX, -0.5, midZ); // Slightly below 0
        floor.receiveShadow = true;
        scene.add(floor);
    }

    // --- Game Initialization ---
    function initializeGame() {
        score = 0;
        ballsLeft = 3;
        gameState = 'launch';
        showHelp = false;
        botModeActive = false;
        // Reset timers
        clearTimeout(botActivationTimer); clearInterval(botCountdownInterval); clearTimeout(botLaunchTimerId);
        botLaunchTimerId = null;
        startBotCountdown();

        helpLegend.classList.add('hidden');
        gameOverScreen.classList.add('hidden');
        
        cleanupScene();
        createFloor();

        world = pl.World({ gravity: Vec2(0, CONFIG.gravity) });

        createLauncher();
        createFieldBoundaries(); // Walls
        createBumperLayout();    // Obstacles
        createComplexFeatures(); // New 3D stuff
        createPhysicsFlippers();
        setupContactListener();

        prepareNextBall();
        updateUI();
    }

    // --- Physics & 3D Objects ---

    function createFieldBoundaries() {
        const wallThickness = 1; // Meters
        const wallHeight = 2;    // Meters 3D
        const bodies = [];

        // 3D Geometry for walls
        const wallMat = new THREE.MeshStandardMaterial({ color: CONFIG.colors.wall, emissive: 0x0044aa, emissiveIntensity: 0.2 });

        // Helper to add wall
        function addWall(x, y, w, h) {
            // Physics
            const body = world.createBody(Vec2(x, y));
            body.createFixture(pl.Box(w/2, h/2));
            
            // 3D
            const geo = new THREE.BoxGeometry(w, wallHeight, h);
            const mesh = new THREE.Mesh(geo, wallMat);
            mesh.position.set(x, wallHeight/2, y); // y is z in 3D logic here for position, but y is up
            mesh.castShadow = true; mesh.receiveShadow = true;
            scene.add(mesh);
        }

        // Left Wall
        addWall(0, px2m(CONFIG.canvasHeight/2), px2m(20), px2m(CONFIG.canvasHeight));
        // Top Wall
        addWall(px2m(CONFIG.canvasWidth/2), 0, px2m(CONFIG.canvasWidth), px2m(20));
        // Right Wall
        addWall(px2m(CONFIG.canvasWidth), px2m(CONFIG.canvasHeight/2), px2m(20), px2m(CONFIG.canvasHeight));
        
        // Chute Separator
        const sepX = px2m(PLAYFIELD_WIDTH_PX);
        const sepH = px2m(CONFIG.canvasHeight - 100); 
        const sepY = px2m(100) + sepH/2;
        addWall(sepX, sepY, 0.2, sepH);

        // Guide Ramp (Curved top right)
        // Approximated by static segments for simplicity in 3D sync
        const rampBody = world.createBody();
        const p1 = Vec2(px2m(CONFIG.canvasWidth), px2m(80));
        const p2 = Vec2(px2m(PLAYFIELD_WIDTH_PX - 40), 0);
        rampBody.createFixture(pl.Edge(p1, p2), { restitution: 0.2 });
        
        // 3D Visual for Ramp (A thin box rotated)
        const rampLen = Vec2.distance(p1, p2);
        const rampCenter = Vec2.mid(p1, p2);
        const rampAngle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
        
        const rampGeo = new THREE.BoxGeometry(rampLen, wallHeight, 0.2);
        const rampMesh = new THREE.Mesh(rampGeo, wallMat);
        rampMesh.position.set(rampCenter.x, wallHeight/2, rampCenter.y);
        rampMesh.rotation.y = -rampAngle;
        scene.add(rampMesh);

        // Drain Sensor
        const drain = world.createBody();
        drain.createFixture(pl.Box(px2m(PLAYFIELD_WIDTH_PX/2), px2m(10), Vec2(px2m(PLAYFIELD_WIDTH_PX/2), px2m(CONFIG.canvasHeight + 10)), 0), { isSensor: true });
        drain.setUserData({ type: 'drain' });
    }

    function createComplexFeatures() {
        // 1. Spinning Cross in the center
        const spinnerX = px2m(PLAYFIELD_WIDTH_PX / 2);
        const spinnerY = px2m(300);
        
        const spinnerBody = world.createDynamicBody(Vec2(spinnerX, spinnerY));
        spinnerBody.createFixture(pl.Box(1.5, 0.2), { density: 50, restitution: 1.2 });
        spinnerBody.createFixture(pl.Box(0.2, 1.5), { density: 50, restitution: 1.2 });
        spinnerBody.setAngularVelocity(2);
        spinnerBody.setUserData({ type: 'bumper', points: 100 });

        // 3D Visual
        const spinnerGroup = new THREE.Group();
        const bar1 = new THREE.Mesh(new THREE.BoxGeometry(3, 0.5, 0.4), new THREE.MeshStandardMaterial({ color: CONFIG.colors.obstacle }));
        const bar2 = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.5, 3), new THREE.MeshStandardMaterial({ color: CONFIG.colors.obstacle }));
        spinnerGroup.add(bar1);
        spinnerGroup.add(bar2);
        spinnerGroup.position.set(spinnerX, 0.25, spinnerY);
        scene.add(spinnerGroup);
        
        // Joint to hold it in place but let it spin
        const anchor = world.createBody(Vec2(spinnerX, spinnerY));
        world.createJoint(pl.RevoluteJoint({
            motorSpeed: 2,
            maxMotorTorque: 100,
            enableMotor: true
        }, anchor, spinnerBody, Vec2(spinnerX, spinnerY)));

        syncableObjects.push({ body: spinnerBody, mesh: spinnerGroup, type: 'spinner' });

        // 2. Triangle Prisms (Static)
        function createPrism(x, y) {
            const body = world.createBody(Vec2(x, y));
            // Triangle shape
            body.createFixture(pl.Polygon([Vec2(0, -0.8), Vec2(0.7, 0.5), Vec2(-0.7, 0.5)]), { restitution: 1.5 });
            body.setUserData({ type: 'bumper', points: 50 });

            const shape = new THREE.Shape();
            shape.moveTo(0, -0.8);
            shape.lineTo(0.7, 0.5);
            shape.lineTo(-0.7, 0.5);
            shape.lineTo(0, -0.8);
            const extrudeSettings = { depth: 0.5, bevelEnabled: false };
            const geo = new THREE.ExtrudeGeometry(shape, extrudeSettings);
            const mat = new THREE.MeshStandardMaterial({ color: 0xaa00ff, emissive: 0x4400aa });
            const mesh = new THREE.Mesh(geo, mat);
            // Extrudes along Z, rotate to lie flat
            mesh.rotation.x = Math.PI / 2;
            mesh.position.set(x, 0.25, y); // Adjust for rotation center
            scene.add(mesh);
        }
        
        createPrism(px2m(100), px2m(400));
        createPrism(px2m(PLAYFIELD_WIDTH_PX - 100), px2m(400));
    }

    function createBumperLayout() {
        const bumpers = [
            { x: 300, y: 150, r: 25 }, { x: 200, y: 200, r: 15 }, 
            { x: 400, y: 200, r: 15 }, { x: 300, y: 250, r: 15 },
            { x: 150, y: 550, r: 20 }, { x: 450, y: 550, r: 20 }
        ];

        const bumperGeo = new THREE.CylinderGeometry(1, 1, 0.5, 32);

        bumpers.forEach(b => {
            const rM = px2m(b.r);
            const xM = px2m(b.x);
            const yM = px2m(b.y);

            // Physics
            const body = world.createBody(Vec2(xM, yM));
            body.createFixture(pl.Circle(rM), { restitution: 1.3 });
            body.setUserData({ type: 'bumper', points: 50 });

            // 3D
            const mesh = new THREE.Mesh(bumperGeo, new THREE.MeshStandardMaterial({ 
                color: CONFIG.colors.bumper, 
                emissive: 0xffaa00,
                emissiveIntensity: 0.5
            }));
            mesh.scale.set(rM, 1, rM);
            mesh.position.set(xM, 0.25, yM);
            mesh.castShadow = true;
            
            // Add a point light to each bumper for "glow"
            const light = new THREE.PointLight(CONFIG.colors.bumper, 0.5, 5);
            light.position.set(0, 1, 0);
            mesh.add(light);
            
            scene.add(mesh);
        });
    }

    function createPhysicsFlippers() {
        // Destroy old if exists
        if(leftFlipper.mesh) { scene.remove(leftFlipper.mesh); world.destroyBody(leftFlipper.body); }
        if(rightFlipper.mesh) { scene.remove(rightFlipper.mesh); world.destroyBody(rightFlipper.body); }
        
        const flipperLength = 85;
        const flipperWidth = 15;
        const flipperY = CONFIG.canvasHeight - 60;
        
        // Calculate gap
        const flipperRestAngle = Math.PI / 8;
        const flipperTotalSpan = (2 * flipperLength * Math.cos(flipperRestAngle)) + flipperGapBetweenTips;
        const leftX = (PLAYFIELD_WIDTH_PX - flipperTotalSpan) / 2;
        const rightX = (PLAYFIELD_WIDTH_PX + flipperTotalSpan) / 2;

        leftFlipper = createOneFlipper(leftX, flipperY, flipperLength, flipperWidth, false);
        rightFlipper = createOneFlipper(rightX, flipperY, flipperLength, flipperWidth, true);

        // Slopes leading to flippers
        createSlopes(leftX, rightX, flipperY);
    }

    function createOneFlipper(x, y, len, width, isRight) {
        const pX = px2m(x);
        const pY = px2m(y);
        const pLen = px2m(len);
        const pW = px2m(width);
        
        const anchor = world.createBody(Vec2(pX, pY));
        const body = world.createDynamicBody(Vec2(pX, pY));
        
        // Visual offset logic: Flipper rotates around one end
        // Box center is (0,0), so offset shape center
        const shapeOffset = isRight ? -pLen/2 : pLen/2;
        body.createFixture(pl.Box(pLen/2, pW/2, Vec2(shapeOffset, 0)), { density: 1.0 });
        body.setUserData({ type: 'flipper' });

        // Motor Joint
        const restAngle = isRight ? -Math.PI/8 : Math.PI/8;
        const swing = Math.PI/3.5;
        const lower = isRight ? restAngle : restAngle - swing;
        const upper = isRight ? restAngle + swing : restAngle;
        
        const joint = world.createJoint(pl.RevoluteJoint({
            lowerAngle: lower, upperAngle: upper, enableLimit: true,
            enableMotor: true, maxMotorTorque: 1000, motorSpeed: 0
        }, anchor, body, Vec2(pX, pY)));

        // 3D Mesh
        const meshGroup = new THREE.Group();
        const geo = new THREE.BoxGeometry(pLen, 0.6, pW);
        const mat = new THREE.MeshStandardMaterial({ color: CONFIG.colors.flipper });
        const mesh = new THREE.Mesh(geo, mat);
        
        // Offset mesh inside group to match physics offset
        mesh.position.x = shapeOffset; 
        mesh.position.y = 0.3; // Half height
        
        meshGroup.add(mesh);
        meshGroup.position.set(pX, 0, pY);
        scene.add(meshGroup);

        return { body, joint, mesh: meshGroup, active: false };
    }

    function createSlopes(lx, rx, fy) {
        // Just visual/physics walls to guide ball to flipper
        const startY = px2m(CONFIG.canvasHeight * 0.6);
        const endY = px2m(fy);
        const lEndX = px2m(lx);
        const rEndX = px2m(rx);
        
        function addSlope(x1, y1, x2, y2) {
            const body = world.createBody();
            body.createFixture(pl.Edge(Vec2(x1, y1), Vec2(x2, y2)));
            
            // 3D Visual
            const len = Math.sqrt((x2-x1)**2 + (y2-y1)**2);
            const ang = Math.atan2(y2-y1, x2-x1);
            const midX = (x1+x2)/2;
            const midY = (y1+y2)/2;
            
            const mesh = new THREE.Mesh(
                new THREE.BoxGeometry(len, 1, 0.2), 
                new THREE.MeshStandardMaterial({ color: 0x555555 })
            );
            mesh.position.set(midX, 0.5, midY);
            mesh.rotation.y = -ang;
            scene.add(mesh);
        }

        addSlope(0, startY, lEndX, endY);
        addSlope(px2m(PLAYFIELD_WIDTH_PX), startY, rEndX, endY);
    }

    function createLauncher() {
        launcher = { 
            x: px2m(PLAYFIELD_WIDTH_PX + CHUTE_WIDTH_PX/2), 
            y: px2m(CONFIG.canvasHeight - 30), 
            power: 0, maxPower: 60, charging: false,
            baseY: px2m(CONFIG.canvasHeight - 30)
        };
        
        // Plunger visual
        const geo = new THREE.BoxGeometry(px2m(20), 0.5, px2m(50));
        const mat = new THREE.MeshStandardMaterial({ color: 0x888888 });
        launcher.mesh = new THREE.Mesh(geo, mat);
        launcher.mesh.position.set(launcher.x, 0.25, launcher.y);
        scene.add(launcher.mesh);
    }

    function prepareNextBall() {
        if (ballsLeft <= 0) { gameState = 'playing'; return; }
        ballsLeft--;
        updateUI();
        
        const r = px2m(BALL_RADIUS_PX);
        const body = world.createDynamicBody({
            position: Vec2(launcher.x, launcher.y),
            bullet: true, linearDamping: 0.1, angularDamping: 0.1
        });
        body.createFixture(pl.Circle(r), { density: 1.0, restitution: 0.5 });
        body.setUserData({ type: 'ball', state: 'ready' });

        // 3D Ball
        const geo = new THREE.SphereGeometry(r, 32, 32);
        const mat = new THREE.MeshStandardMaterial({ 
            color: CONFIG.colors.ball, 
            roughness: 0.1, 
            metalness: 0.5 
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = true;
        scene.add(mesh);

        syncableObjects.push({ body, mesh, type: 'ball' });
        
        gameState = 'launch';
        launcher.power = 0;
        
        if (botModeActive) { botLaunchTimerId = setTimeout(botLaunchBall, 3000); }
    }

    function launchBall() {
        const ballObj = syncableObjects.find(o => o.type === 'ball' && o.body.getUserData().state === 'ready');
        if (ballObj) {
            ballObj.body.applyLinearImpulse(Vec2(0, -launcher.power), ballObj.body.getWorldCenter(), true);
            ballObj.body.getUserData().state = 'playing';
            playSound('launch');
            prepareNextBall();
        }
    }

    function setupContactListener() {
        world.on('begin-contact', (contact) => {
            const getData = (fixture) => fixture.getBody().getUserData() || {};
            const dA = getData(contact.getFixtureA());
            const dB = getData(contact.getFixtureB());
            
            // Identify if one is a ball
            let ballData = dA.type === 'ball' ? dA : (dB.type === 'ball' ? dB : null);
            let otherData = dA.type === 'ball' ? dB : dA;
            let ballBody = dA.type === 'ball' ? contact.getFixtureA().getBody() : contact.getFixtureB().getBody();

            if (!ballData) return;
            if (ballData.state !== 'playing' && otherData.type !== 'drain') return;

            if (otherData.type === 'bumper') {
                score += otherData.points || 10;
                playSound('bounce');
                updateUI();
                
                // Visual Hit Effect? (Could change color temporarily)
            } else if (otherData.type === 'flipper') {
                playSound('flipper');
            } else if (otherData.type === 'drain') {
                playSound('lose');
                ballsToRemove.push(ballBody);
            }
        });
    }

    // --- Main Loop ---
    function animate() {
        requestAnimationFrame(animate);

        if (gameState !== 'gameOver') {
            // 1. Physics Step
            // Fixed time step for physics consistency
            world.step(1/60, 8, 3);
            
            // 2. Game Logic
            updateGameLogic();

            // 3. Sync Physics to 3D
            syncPhysicsToGraphics();
        }
        
        renderer.render(scene, camera);
    }

    function updateGameLogic() {
        // Bot Logic
        if (botModeActive && !showHelp) {
            runBotLogic();
        }

        // Flipper Motor Control
        const speed = 25; 
        leftFlipper.joint.setMotorSpeed(leftFlipper.active ? -speed : speed);
        rightFlipper.joint.setMotorSpeed(rightFlipper.active ? speed : -speed);

        // Launcher Charging
        if (gameState === 'launch') {
            const ballObj = syncableObjects.find(o => o.type === 'ball' && o.body.getUserData().state === 'ready');
            if (launcher.charging && launcher.power < launcher.maxPower) {
                launcher.power += 1.0;
            }
            // Move ball visually with plunger
            if (ballObj) {
                const offset = launcher.power / CONFIG.pixelsPerMeter / 4; 
                ballObj.body.setPosition(Vec2(launcher.x, launcher.baseY + offset)); // Plunger pushes up, but physics Y is down? 
                // Wait, impulse is (0, -power). Negative Y is UP in Planck visual logic usually, but here Y increases downwards.
                // Impulse -power pushes UP (towards 0). 
                // Plunger visual should retract (go down/positive Y) to charge.
                const visualY = launcher.baseY + (launcher.power / 500); // Slight movement
                // Simplified: just update mesh based on body which is static until launch
            }
            
            // Update plunger mesh position
            launcher.mesh.position.z = launcher.baseY + (launcher.power / CONFIG.pixelsPerMeter / 2);
        }

        // Remove Balls
        if (ballsToRemove.length > 0) {
            ballsToRemove.forEach(b => {
                const idx = syncableObjects.findIndex(o => o.body === b);
                if (idx !== -1) {
                    scene.remove(syncableObjects[idx].mesh);
                    syncableObjects.splice(idx, 1);
                }
                world.destroyBody(b);
            });
            ballsToRemove = [];
            
            // Check Game Over
            const activeBalls = syncableObjects.filter(o => o.type === 'ball' && o.body.getUserData().state === 'playing');
            if (activeBalls.length === 0 && ballsLeft <= 0) {
                const readyBall = syncableObjects.find(o => o.type === 'ball' && o.body.getUserData().state === 'ready');
                if (!readyBall) endGame();
            }
        }
    }

    function syncPhysicsToGraphics() {
        syncableObjects.forEach(obj => {
            const p = obj.body.getPosition();
            const a = obj.body.getAngle();
            
            // Mapping: Physics X -> 3D X, Physics Y -> 3D Z
            obj.mesh.position.x = p.x;
            obj.mesh.position.z = p.y;
            
            if (obj.type === 'ball') {
                // Ball rolls: Calculate rotation axis based on velocity
                const v = obj.body.getLinearVelocity();
                // If moving in +Z (down), rotate around +X. If moving in +X (right), rotate around -Z?
                // Simple approximation:
                obj.mesh.rotation.x += v.y * 0.05;
                obj.mesh.rotation.z -= v.x * 0.05;
                obj.mesh.position.y = px2m(BALL_RADIUS_PX); // Sit on floor
            } else {
                // Standard Y-axis rotation (up axis in 3D) for walls/flippers
                // Physics angle is counter-clockwise. Three.js Y rotation is counter-clockwise.
                // However, we look from -Z or +Z. Usually necessitates a sign flip.
                obj.mesh.rotation.y = -a; 
            }
        });

        // Sync Flipper Meshes (Groups)
        function syncFlipper(f) {
            const p = f.body.getPosition();
            const a = f.body.getAngle();
            f.mesh.position.x = p.x;
            f.mesh.position.z = p.y;
            f.mesh.rotation.y = -a;
        }
        syncFlipper(leftFlipper);
        syncFlipper(rightFlipper);
    }

    function runBotLogic() {
        const flipperY = leftFlipper.body.getPosition().y;
        
        syncableObjects.filter(o => o.type === 'ball').forEach(ball => {
            const bBody = ball.body;
            const bPos = bBody.getPosition();
            const bVel = bBody.getLinearVelocity();
            
            if (bBody.getUserData().state === 'playing' && bPos.y < flipperY && bVel.y > 0.5) {
                // Simple prediction
                const timeToIntersect = (flipperY - bPos.y) / bVel.y;
                if (timeToIntersect < 0.15) {
                    const mid = px2m(PLAYFIELD_WIDTH_PX / 2);
                    if (bPos.x < mid && botLeftFlipperHoldFrames === 0) botLeftFlipperHoldFrames = BOT_FLIPPER_HOLD_DURATION_FRAMES;
                    if (bPos.x > mid && botRightFlipperHoldFrames === 0) botRightFlipperHoldFrames = BOT_FLIPPER_HOLD_DURATION_FRAMES;
                }
            }
        });

        if (botLeftFlipperHoldFrames > 0) { leftFlipper.active = true; botLeftFlipperHoldFrames--; } 
        else leftFlipper.active = false;
        
        if (botRightFlipperHoldFrames > 0) { rightFlipper.active = true; botRightFlipperHoldFrames--; } 
        else rightFlipper.active = false;
    }

    // --- Interaction & Events ---
    function updateUI() { 
        scoreEl.innerText = score; 
        attemptsEl.innerText = ballsLeft; 
    }
    
    function endGame() {
        gameState = 'gameOver';
        finalScoreEl.innerText = score;
        gameOverScreen.classList.remove('hidden');
    }

    function toggleHelp() { 
        showHelp = !showHelp; 
        helpLegend.classList.toggle('hidden'); 
    }

    // Bot Mode Utils
    function startBotCountdown() {
        if (!botStatusText) return; 
        let countdown = 5;
        botStatusText.textContent = `Bot mode starts in: ${countdown}s`;
        botCountdownInterval = setInterval(() => {
            countdown--;
            if (countdown > 0) botStatusText.textContent = `Bot mode starts in: ${countdown}s`;
            else { clearInterval(botCountdownInterval); botStatusText.textContent = `Bot mode starting...`; }
        }, 1000);
        botActivationTimer = setTimeout(() => {
            if (gameState !== 'gameOver') { 
                if (showHelp) toggleHelp();
                botModeActive = true; updateBotStatusText();
                if (gameState === 'launch') botLaunchBall();
            }
        }, 5000);
    }
    
    function toggleBotMode() { 
        unlockAudio(); botModeActive = !botModeActive; 
        clearTimeout(botActivationTimer); clearInterval(botCountdownInterval); 
        updateBotStatusText(); 
    }
    
    function cancelBotMode() { 
        if (botModeActive) { 
            botModeActive = false; 
            clearTimeout(botLaunchTimerId); 
            updateBotStatusText(); 
        } 
    }
    
    function botLaunchBall() { launcher.power = launcher.maxPower; launchBall(); }
    function updateBotStatusText() { botStatusText.textContent = `Bot Mode: ${botModeActive ? 'ON' : 'OFF'}`; }

    // Inputs
    window.addEventListener('keydown', (e) => {
        unlockAudio();
        if (botModeActive && ['ArrowLeft','ArrowRight','Space'].includes(e.code)) cancelBotMode();
        if (e.code === 'KeyH') toggleHelp();
        if (e.code === 'KeyM') { isMuted = !isMuted; muteButton.innerText = isMuted ? 'Unmute' : 'Mute'; }
        if (e.code === 'KeyB') toggleBotMode();
        if (showHelp || gameState === 'gameOver') return;
        
        if (e.code === 'KeyG') {
            flipperGapBetweenTips += px2m(5);
            createPhysicsFlippers();
        }
        if (e.code === 'ArrowLeft') leftFlipper.active = true;
        if (e.code === 'ArrowRight') rightFlipper.active = true;
        if (e.code === 'Space' && gameState === 'launch') launcher.charging = true;
    });

    window.addEventListener('keyup', (e) => {
        if (e.code === 'ArrowLeft') leftFlipper.active = false;
        if (e.code === 'ArrowRight') rightFlipper.active = false;
        if (e.code === 'Space' && gameState === 'launch' && launcher.charging) {
            launcher.charging = false;
            launchBall();
        }
    });

    // Touch
    const setupTouch = (id, type) => {
        const el = document.getElementById(id);
        const start = (e) => { 
            e.preventDefault(); unlockAudio(); 
            if(botModeActive) cancelBotMode();
            if(type==='l') leftFlipper.active=true; 
            if(type==='r') rightFlipper.active=true; 
            if(type==='fire' && gameState==='launch') launcher.charging=true; 
        };
        const end = (e) => { 
            e.preventDefault();
            if(type==='l') leftFlipper.active=false; 
            if(type==='r') rightFlipper.active=false; 
            if(type==='fire' && gameState==='launch') { launcher.charging=false; launchBall(); }
        };
        el.addEventListener('mousedown', start); el.addEventListener('touchstart', start);
        el.addEventListener('mouseup', end); el.addEventListener('touchend', end);
    };
    setupTouch('touch-left', 'l');
    setupTouch('touch-right', 'r');
    setupTouch('touch-launch', 'fire');

    // UI Buttons
    restartButton.addEventListener('click', initializeGame);
    closeHelpButton.addEventListener('click', toggleHelp);
    muteButton.addEventListener('click', () => { isMuted = !isMuted; muteButton.innerText = isMuted ? 'Unmute' : 'Mute'; });
    helpToggleButton.addEventListener('click', toggleHelp);
    gapButton.addEventListener('click', () => { flipperGapBetweenTips += px2m(5); createPhysicsFlippers(); });
    themeToggleButton.addEventListener('click', () => {
        document.body.classList.toggle('light-mode');
        const isLight = document.body.classList.contains('light-mode');
        themeToggleButton.textContent = isLight ? 'Dark Mode' : 'Light Mode';
        // Adjust ambient light for theme
        ambientLight.intensity = isLight ? 0.8 : 0.4;
        scene.background = new THREE.Color(isLight ? 0xe0e0e0 : 0x000000);
    });

    // Start
    initializeGame();
    toggleHelp();
    animate();
});
