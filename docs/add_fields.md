## Adding additional fields ##
By default logtrail shows following fields for each log event:

 - timestamp
 - hostname
 - program
 - message
 
These fields can be mapped to respective Elasticsearch documents using `fields.mapping` parameter in `logtrail.json`. Logtrail provides option to add additional fields to the log event. This can be done using the `fields.message_format` parameter in `logtrail.json`. By default this parameter is mapped to `syslog_message`. 

**NOTE** : Using `fields.message_format` will replace whatever is defined in `fields.mapping.message`.

Let us consider following source document present in Elasticsearch :
```ruby
{
          "hostname" => "playground",
        "@timestamp" => 2017-03-31T14:10:36.000Z,
              "port" => 52434,
  "syslog_timestamp" => "Mar 31 19:40:36",
          "@version" => "1",
              "host" => "127.0.0.1",
               "pid" => "14289",
           "program" => "dhclient",
           "message" => "<30>Mar 31 19:40:36 playground dhclient[14289]: DHCPDISCOVER on eth1 to 255.255.255.255 port 67 interval 7 (xid=0x3993f38)",
              "type" => "syslog",
    "syslog_message" => "DHCPDISCOVER on eth1 to 255.255.255.255 port 67 interval 7 (xid=0x3993f38)"
}
```

To add `pid` and `host ip address` to each log event following is the configuration changes required:

```json
"fields" : {
    "mapping" : {
        "timestamp" : "@timestamp",
        "display_timestamp" : "@timestamp",
        "hostname" : "hostname",
        "program": "program",
        "message": "syslog_message"
    },
    "message_format": "{{{host}}} | {{{pid}}} : {{{syslog_message}}}"
  }
```
For the above configuration the event console display will be like:

![Add Fields screenshot](https://raw.githubusercontent.com/sivasamyk/logtrail/master/docs/add_fields.png)

On clicking additional field, logtrail will automatically search for log messages matching the value of the field. For example on clicking the pid `16545` in above message, logtrail will search for all message whose pid is `16545` in this index.

Logtrail uses Handlebar templates to replace the fields in `message_format` with actual values. `{{{field_name}}}` will add field with hyperlink. `{{field_name}}` will add field without hyperlink. `{{[nested.field]}}` should be used to add nested fields.


### Caveats

#### Nested fields

Some fields may appear as nested in Kibana while actually they are not. When displaying a document in "table view" in Kibana, these 2 fields will be displayed the same way :  
- log.level
- [log][level] (following Logstash syntax)

When displaying the document in json view, you'll see clearly the difference though.

If you configure Logtrail as below :

    "message_format": "{{{log.level}}} - {{{message}}}"

It will work **only** if log.level is really nested (ie [log][level]). It will not work if your documents have a simple field named "log.level". 

See this [issue](https://github.com/sivasamyk/logtrail/issues/387) for more infos. 


