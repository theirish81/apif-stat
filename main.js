const yargs = require('yargs');
const moment = require('moment');
const request = require('request-promise')
const process = require('process')
const util = require('util')
const fs = require('fs')
const mustache = require('mustache')

// Parsing command line args
const argv = parseArgv()
// Extracting dates from argv
const [start,end] = evaluateDates(argv)

/**
 * In case the dates are invalid, we emit an error and stop further processing
 */
if(!start.isValid() || !end.isValid()){
    console.error('[ERROR] Start/end dates not properly defined')
    process.exit(1)
}
console.info('[INFO ] Collecting data between: ',start.toDate(),end.toDate())

/**
 * Collecting project details
 */
const p0 = request.get(argv.hook).then((data) => JSON.parse(data).name)
/**
 * Collecting events stats
 */
const p1 = computeEvents(0,initEventsContainer())
/**
 * Collecting metrics stats
 */
const p2 = computeMetrics(0,initMetricsContainer())

/**
 * Processing all things
 */
Promise.all([p0,p1,p2]).then((data) => { 
                            /**
                             * Merging the objects together
                             */ 
                            return {start:start.toDate(),end:end.toDate(),name:data[0],events:data[1],metrics:data[2]}
                        }).then((data) => {
                            /*
                             * Processing the desired output
                             */ 
                            var outData = ''
                            const template = readTemplate(argv.template)
                            // If template is null, the output is going to be the JSON data structure
                            if(template === null)
                                outData = util.inspect(data,{depth:null,colors:false})
                            else
                                // Otherwise, we process the template
                                outData = processTemplate(data,template)
                            return outData
                        }).then((data) => {
                            /**
                             * Writing to file
                             */
                            if(argv.output === undefined)
                                // If there's no output argument, out.txt is selected
                                argv.output = 'out.txt'
                            console.log('[INFO ] Writing to file')
                            // Writing to file
                            fs.writeFile(argv.output,data,(err) => {
                                if(err != null)
                                    console.log('[ERROR] Failure while writing to file')
                            })
                            
                        })


/**
 * Parses command line arguments
 * @returns the parsed argv
 */
function parseArgv() {
    return yargs.command('create', 'Creates a report', {
                start: {
                    description: 'The start date in the YYYY/MM/DD format',
                    alias: 's',
                    type: 'string',
                    required: true
                },
                end: {
                    description: 'The end date in the YYYY/MM/DD format',
                    alias: 'e',
                    type: 'string'
                },
                hook: {
                    description: 'An API Fortress webhook',
                    alias: 'k',
                    type: 'string',
                    required: true
                },
                template: {
                    description: 'The template file name within the templates/ directory',
                    alias: 'T',
                    type: 'string'
                },
                output: {
                    description: 'Output file name',
                    alias: 'o',
                    type: 'string',
                    required: true
                }
            }).demandCommand(1).help().alias('help', 'h').showHelpOnFail(true).argv;
}

/**
 * Evaluates start and end dates
 * @param {object} argv the parsed command line arguments
 * @returns {array} start and end dates in an array
 */
function evaluateDates(argv) {
    const start = moment(argv.start,'YYYY/MM/DD')
    if(argv.end == null){
        argv.end = moment().format('YYYY/MM/DD')
    }
    const end = moment(argv.end,'YYYY/MM/DD');
    return [start, end]
}

/**
 * Collects events and produces aggregated stats
 * @param {integer} offset number of items to skip in the result set
 * @param {object} events object that will collect the results
 * @returns {Promise} the promise for this operation
 */
function computeEvents(offset,events) {
    console.log('[INFO ] Event Offset: ',offset)
    return request.get(argv.hook+'/insights/events?offset='+offset.toString()+'&limit=500&from='+start.valueOf()+"&to="+end.valueOf()).then(data =>{
                                        /**
                                         * Page loaded, we can go through each event and produce stats
                                         */
                                        const d2 = JSON.parse(data)
                                        d2.forEach((item) => {
                                            // Global stats
                                            countAndApplyEvents(item,events)
                                            // Stats by tag
                                            if(item.tags !== undefined)
                                                item.tags.forEach((tag) => events.tags[tag] = countAndApplyEvents(item,events.tags[tag]))
                                            // Stats for untagged
                                            if(item.tags === undefined || item.tags.length == 0)
                                                events.tags.untagged = countAndApplyEvents(item,events.tags.untagged)
                                        })
                                        return d2
                                    }).then( (d3) => {
                                        /**
                                         * If the page lengh is 500, it most likely means there are more, so we move the offset and repeat
                                         */
                                        if(d3.length == 500)
                                            return computeEvents(offset+500,events)
                                        else
                                            return events
                                    })
}

/**
 * Collects metrics and produces aggregated stats
 * @param {integer} offset number of items 
 * @param {*} metrics object that will collect the results
 * @returns {Promise} the promise for this operation
 */
function computeMetrics(offset,metrics){
    console.log('[INFO ] Metrics Offset: ',offset)
    return request.get(argv.hook+'/insights/metrics?offset='+offset.toString()+'&limit=1000&from='+start.valueOf()+"&to="+end.valueOf()).then(data =>{
                                /**
                                 * Page loaded, we can go through each metric and produce stats
                                 */
                                const d2 = JSON.parse(data)
                                d2.forEach(item => {
                                    // Global stats
                                    measureAndApplyMetrics(item,metrics)
                                    // Stats by footprint
                                    metrics.footprints[item.footprint] = measureAndApplyMetrics(item,metrics.footprints[item.footprint])
                                });
                                return d2
                            }).then( (d3) => {
                                /**
                                 * If the page lengh is 1000, it most likely means there are more, so we move the offset and repeat
                                 */
                                if(d3.length == 1000)
                                    return computeMetrics(offset+1000,metrics)
                                else
                                    return metrics
                            })
}

/**
 * Initializes the metrics container object
 * @returns {object} the metrics container object
 */
function initMetricsContainer() {
    return {successes:0,failures:0,criticals:0,fetch:0,latency:0,_tmp: {totalFetch:0,totalLatency:0}, footprints:{}}
}

/**
 * Given a metrics item, it computes the stats and updates the container object
 * @param {object} item a metrics item as provided by the API
 * @param {object} container the container object that collects aggregated stats for metrics
 * @returns {object} the container object
 */
function measureAndApplyMetrics(item,container){
    if(container == null)
        container = initMetricsContainer()
    if(item.success)
        container.successes++
    else
        container.failures++
    if(parseInt(item.code)<=0)
        container.criticals++
    container._tmp.totalFetch+=item.fetch
    container._tmp.totalLatency+=item.latency
    container.fetch = (container._tmp.totalFetch / (container.successes+container.failures))
    container.latency = (container._tmp.totalLatency / (container.successes+container.failures))

    return container

}

/**
 * Initializes the event container object
 * @returns {object} the events container object
 */
function initEventsContainer(){
    return {successes:0,failures:0,criticals:0,tags:{}}
}

/**
 * 
 * @param {object} item an event as provided by the API
 * @param {object} container the container object that collects aggregated stats for events
 * @returns {object} the container object
 */
function countAndApplyEvents(item, container){
    if(container == null)
        container = initEventsContainer()
    if(item.failuresCount > 0)
        container.failures++
    else
        container.successes++
    if(item.criticalFailures.length > 0)
        container.criticals++
    return container
}

/**
 * Loads a template from file
 * @param {string} filename the file name for the template
 * @returns {string} the body of the template, or null in case the filename is null, or the file does not exist
 */
function readTemplate(filename) {
    if(filename === undefined)
        return null
    if(fs.existsSync('templates/'+filename))
        return fs.readFileSync('templates/'+filename,'utf-8')
    return null
}

/**
 * Processes a template with the given model
 * @param {object} data the data to be used as model
 * @param {string} template the template in string form
 * @returns {string} the rendered model as a string
 */
function processTemplate(data,template) {
    /**
     * Adding the toFixed function to the data structure so that it can be used from within the template
     */
    data.toFixed = function() {
        return function(num, render) {
            return parseFloat(render(num)).toFixed(2);
        }
    }
    // Converting tags and footprint maps to arrays for Mustache to consume
    data.events.tags = objs2list(data.events.tags)
    data.metrics.footprints = objs2list(data.metrics.footprints)
    
    // Formatting dates
    data.start = moment(data.start).format('YYYY/MM/DD')
    data.end = moment(data.end).format('YYYY/MM/DD')
    return mustache.render(template,data)
}

/**
 * Converts a map into an array to help Mustache
 * @param {object} p an object
 * @returns {array} an array
 */
function objs2list(p) {
    r = [];
    for (var key in p) if (p.hasOwnProperty(key)) {
      r.push({"@key":key,"@val":p[key]});
    }
    return r;
  }