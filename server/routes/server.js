var dateformat = require('dateformat');

/**
 * Takes a pattern of the form blah-
 * and converts it into a list of indexes with dates appended
 */
function toDatedIndexPattern(prefix, start, days, as) {
  // alias
  var self = this;

  // sanity checks
  if ((!prefix) || (!start) || (days < 0))
    return;

  // remove the star at the end
  prefix = prefix.replace('*','');

  // default
  as = (as) ? as : 'string';

  // indexes we care about
  var indexes = [];

  // how many millis are in one day          
  var DAY = 86400000;          

  // add the number of days
  for (var index=0; index<days; index++) {
    var date = new Date(start.getTime() + (index * DAY));
    
    // the 3rd arg 'true' ensures that we keep the date in UTC instead of local time
    var indexname = prefix + dateformat(date, 'yyyy.mm.dd', true);
    
    // add to set of indices
    indexes.push(indexname);
  }

  // return content
  return as == 'string' ? indexes.join(',') : indexes;
}

function getMessageTemplate(handlebar, selectedConfig) {
  var messageFormat = selectedConfig.fields.message_format;
  //Append <a> tags for click to message format except for message field
  var messageFormatRegex = /({{{[\[]?(\S+?)[\]]?}}})/g; // e.g. {{{[pid]}}} {{{program-name}}} : {{syslog_message}}
  var ngClickTemplate = handlebar.compile('<a class="ng-binding" ng-click="onClick(\'{{name_no_braces}}\',\'{{name}}\')">{{name}}</a>',
    {
      knownHelpers: {
        log: false,
        lookup: false
      },
      knownHelpersOnly: true
    });
  var messageField = selectedConfig.fields.mapping.message;
  var messageTemplate = messageFormat;

  var match = messageFormatRegex.exec(messageFormat);
  while (match !== null) {
    if (match[2] !== messageField) {
      var context = {
        name : match[0],
        name_no_braces : match[2]
      };
      var messageWithClickAttr = ngClickTemplate(context);
      messageTemplate = messageTemplate.replace(match[0], messageWithClickAttr);
    }
    match = messageFormatRegex.exec(messageFormat);
  }
  return messageTemplate; //<a class="ng-binding" ng-click="onClick('pid','{{pid}}')">{{pid}}</a> : {{syslog_message}}
}

function convertToClientFormat(selectedConfig, esResponse) {
  var clientResponse = [];
  var hits = esResponse.hits.hits;
  var template = null;
  var messageFormat = selectedConfig.fields.message_format;
  if (messageFormat) {
    var handlebar = require('handlebars');
    var messageTemplate = getMessageTemplate(handlebar, selectedConfig);
    template = handlebar.compile(messageTemplate, {
      knownHelpers: {
        log: false,
        lookup: false
      },
      knownHelpersOnly: true
    });
  }
  for (let i = 0; i < hits.length; i++) {
    var event = {};
    var source =  hits[i]._source;
    event.id = hits[i]._id;
    let get = require('lodash/get');
    event.timestamp = get(source, selectedConfig.fields.mapping.timestamp);
    event.hostname = get(source, selectedConfig.fields.mapping.hostname);
    event.program = get(source, selectedConfig.fields.mapping.program);

    //Calculate message color, if configured
    if (selectedConfig.color_mapping && selectedConfig.color_mapping.field) {
      var colorField = get(source, selectedConfig.color_mapping.field);
      var color = selectedConfig.color_mapping.mapping[colorField];
      if (color) {
        event.color =  color;
      }
    }

    //Change the source['message'] to highlighter text if available
    if (hits[i].highlight) {
      var set = require('lodash/set');
      var withHighlights = get(hits[i].highlight, [selectedConfig.fields.mapping.message,0]);
      set(source, selectedConfig.fields.mapping.message, withHighlights);
      source[selectedConfig.fields.mapping.message] = hits[i].highlight[selectedConfig.fields.mapping.message][0];
    }
    var message = get(source, selectedConfig.fields.mapping.message);
    //sanitize html
    var escape = require('lodash/escape');
    message = escape(message);
    //if highlight is present then replace pre and post tag with html
    if (hits[i].highlight) {
      message = message.replace(/logtrail.highlight.pre_tag/g,'<span class="highlight">');
      message = message.replace(/logtrail.highlight.post_tag/g,'</span>');
    }
    source[selectedConfig.fields.mapping.message] = message;

    //If the user has specified a custom format for message field
    if (messageFormat) {
      event.message = template(source);
    } else {
      event.message = message;
    }
    clientResponse.push(event);
  }
  return clientResponse;
}

function getDefaultTimeRangeToSearch(selectedConfig) {
  var defaultTimeRangeToSearch = null;
  var moment = require('moment');
  if (selectedConfig.default_time_range_in_minutes && 
    selectedConfig.default_time_range_in_minutes !== 0) {
    defaultTimeRangeToSearch = moment().subtract(
      selectedConfig.default_time_range_in_minutes,'minutes').valueOf();
  } else if (selectedConfig.default_time_range_in_days !== 0) {
    defaultTimeRangeToSearch = moment().subtract(
      selectedConfig.default_time_range_in_days,'days').startOf('day').valueOf();
  }
  return defaultTimeRangeToSearch;
}

module.exports = function (server) {

  //Search
  server.route({
    method: ['POST'],
    path: '/logtrail/search',
    handler: async function (request, h) {
      const { callWithRequest } = server.plugins.elasticsearch.getCluster('data');
      var selectedConfig = request.payload.config;
      var searchText = request.payload.searchText;

      if (searchText == null || searchText.length === 0) {
        searchText = '*';
      }

      //Search Request body
      var searchRequest = {
        index: selectedConfig.es.default_index,
        size: selectedConfig.max_buckets,
        body : {
          sort : [{}],
          query : {
            bool : {
              must :{
                query_string : {
                  analyze_wildcard: true,
                  default_field : selectedConfig.fields.mapping.message,
                  query : searchText
                }
              },
              filter: {
                bool : {
                  must : [
                  ],
	                  must_not:[],
                }
              }
            }
          },
          highlight : {
            pre_tags : ['logtrail.highlight.pre_tag'],
            post_tags : ['logtrail.highlight.post_tag'],
            fields : {
            }
          }
        }
      };
      //Enable highlightng on message field
      searchRequest.body.highlight.fields[selectedConfig.fields.mapping.message] = {
        number_of_fragments: 0
      };

      //By default Set sorting column to timestamp
      searchRequest.body.sort[0][selectedConfig.fields.mapping.timestamp] = {'order':request.payload.order ,'unmapped_type': 'boolean'};

      // If secondary sorting field is present then set secondary sort.
      let secondarySortField = selectedConfig.fields.secondary_sort_field;
      if (secondarySortField != undefined) {
        if (secondarySortField.length > 0) {
          searchRequest.body.sort[0][secondarySortField] = {'order':request.payload.order}
        }
      }

      //If hostname is present then term query.
      if (request.payload.hostname != null) {
        var termQuery = {
          term : {
          }
        };
        var hostnameField = selectedConfig.fields.mapping.hostname;
        let keywordSuffix = selectedConfig.fields.keyword_suffix;
        if (keywordSuffix == undefined) {
          hostnameField += ('.keyword');
        } else if (keywordSuffix.length > 0) {
          hostnameField += ('.' + keywordSuffix);
        }
        termQuery.term[hostnameField] = request.payload.hostname;
        searchRequest.body.query.bool.filter.bool.must.push(termQuery);
      }

      //If no time range is present get events based on default selectedConfig
      var timestamp = request.payload.timestamp;
      var rangeType = request.payload.rangeType;
      if (timestamp == null) {
        let defaultTimeRange = getDefaultTimeRangeToSearch(selectedConfig);
        if (defaultTimeRange) {
          timestamp = defaultTimeRange;
          rangeType = 'gte';
        }
      }

      //If timestamps are present set ranges
      if (timestamp != null) {
        var rangeQuery = {
          range : {

          }
        };
        var range = rangeQuery.range;
        range[selectedConfig.fields.mapping.timestamp] = {};
        range[selectedConfig.fields.mapping.timestamp][rangeType] = timestamp;
        range[selectedConfig.fields.mapping.timestamp].format = 'epoch_millis';
        searchRequest.body.query.bool.filter.bool.must.push(rangeQuery);
      }
      //console.log(JSON.stringify(searchRequest));
      try {
        const resp = await callWithRequest(request,'search',searchRequest);
        return {
          ok: true,
          resp: convertToClientFormat(selectedConfig, resp)
        };
      } catch(e) {
        console.error('Error while executing search', e);
        return {
          ok: false,
          resp: e
        };
      }
    }
  });

  //Get All Systems
  server.route({
    method: ['POST'],
    path: '/logtrail/hosts',
    handler: async function (request, h) {
      const { callWithRequest } = server.plugins.elasticsearch.getCluster('data');
      var selectedConfig = request.payload.config;
      var index = request.payload.index ? request.payload.index : selectedConfig.es.default_index;

      // how many millis are in one day
      var DAY = 86400000;

      // seek region
      var start = null;
      var indexes = null;
      var seek = (request.payload && request.payload.seek) ? request.payload.seek : null;
      if (seek) {
          // shrink down the number of indexes we will look at
          start = new Date(seek - Math.floor((DAY * selectedConfig.default_time_range_in_days) / 2 ));
          indexes = toDatedIndexPattern(index, start, selectedConfig.default_time_range_in_days+1, 'string');
      } else {
          // shrink down the number of indexes we will look at
          start = new Date(new Date().getTime() - (DAY * selectedConfig.default_time_range_in_days));
          indexes = toDatedIndexPattern(index, start, selectedConfig.default_time_range_in_days+1, 'string');
      }

      var hostnameField = selectedConfig.fields.mapping.hostname;
      let keywordSuffix = selectedConfig.fields.keyword_suffix;
      if (keywordSuffix == undefined) {
        hostnameField += ('.keyword');
      } else if (keywordSuffix.length > 0) {
        hostnameField += ('.' + keywordSuffix);
      }
      var hostAggRequest = {
        index: indexes || index,
        ignore_unavailable:true,
        body : {
          size: 0,
          aggs: {
            hosts: {
              terms: {
                field: hostnameField,
                size: selectedConfig.max_hosts
              }
            }
          }
        }
      };
      try {
        const resp = await callWithRequest(request,'search',hostAggRequest);
        if (!resp.aggregations) {
          return {
            ok: false,
            resp: {
              msg: 'Check if the index pattern ' + index + ' exists'
            }
          };
        }
        return {
          ok: true,
          resp: resp.aggregations.hosts ? resp.aggregations.hosts.buckets : []
        };
      } catch(e) {
        console.error('Error while fetching hosts',e);
        return {
          ok: false,
          resp: e
        };
      }
    }
  });

  server.route({
    method: 'GET',
    path: '/logtrail/config',
    handler: async function (request) {
      var config = await loadConfig(server);
      return {
        ok: true,
        config: config
      };
    }
  });
};

function loadConfig(server) {
  return new Promise((resolve, reject) => {
    const { callWithInternalUser } = server.plugins.elasticsearch.getCluster('admin');
    var request = {
      index: '.logtrail',
      type: '_doc',
      id: 1
    };
    callWithInternalUser('get',request).then(function (resp) {
      //If elasticsearch has config use it.
      resolve(resp._source);
      server.log (['info','status'],'Loaded logtrail config from Elasticsearch');
    }).catch(function (error) {
      server.log (['info','status'],'Error while loading config from Elasticsearch. Will use local');
      var config = require('../../logtrail.json');
      resolve(config);
    });
  });
}
