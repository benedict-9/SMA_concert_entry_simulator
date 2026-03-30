//-----GLOBAL CONFIG-----//
const CONFIG = {
    arrival_rate: 0,
    vip_rate: 0,
    batch_size: 0,
    batch_interval: 0,

    bagcheck_lanes: 0,
    wrist_band_counters: 0,
    water_stations: 0,

    sim_speed: 0,
};

//-----STATE DEFINITIONS-----//
const STATES = {
    ARRIVAL: 0,
    HOLDING: 0,
    BATCH: 0,
    BAGCHECK: 0,
    WRISTBAND: 0,
    WATER: 0,
    ENTERED: 0,
    EXITED: 0
}

//-----DATA STRUCTURES-----//

// attendees
let attendees = [];
let nextID = 0;

// queues
let queues = {
    holding: [],
    bagcheck: [],
    wristband: [],
    water: []
}

let vip_queue = [];
let normal_queue = [];

//-----SIM TIME-----//
let current_time = 0;
let is_running = false;

//-----SIMULATION LOOP-----//
function sim_step(){
    if (!is_running) return;
    // simulation logic here
}

// OTHEr FUNCTIONS put here //
//-------------------------//
//                        //



//-----D3 SETUP-----//
let svg;

function initCanvas(){
    svg = d3.select("#canvas")
    .append("svg")
    .attr("width", "100%")
    .attr("height", "100%");
}

//-----BEGIN SIM-----//
function init() {
    initCanvas();

    setInterval(sim_step, 100);
}