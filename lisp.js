var fs = require("fs");

var sourceString = "";
function parse(str) {
  sourceString = str;
  return parseHelper(str, 0);
}

function parseHelper(str, charPos) {
  if(str.charAt(0) === "'") return [Node("quote", "identifier", charPos), parseHelper(str.substring(1), charPos + 1)];
  if(str.charAt(0) === "`") return [Node("syntax-quote", "identifier", charPos), parseHelper(str.substring(1), charPos + 1)];
  if(str.charAt(0) === "~" && str.charAt(1) === "@") return [Node("unquote-splice", "identifier", charPos), parseHelper(str.substring(2), charPos + 2)];
  if(str.charAt(0) === "~") return [Node("unquote", "identifier", charPos), parseHelper(str.substring(1), charPos + 1)];

  var rightParen = str.charAt(str.length - 1) === ")";
  var leftParen = str.charAt(0) === "(";

  if(!leftParen && rightParen) throw new Error("First char isn't an open paren. str: " + str);
  if(!rightParen && leftParen) throw new Error("Last char isn't a close paren. str: " + str);

  if(!rightParen && !leftParen) {
    // Number
    if(!isNaN(str)) {
      return Node(parseFloat(str), "number", charPos);
    }

    // Bool
    if(str === "false" || str === "true") {
      return Node(str === "true", "boolean", charPos);
    }

    // Strings
    if(str.charAt(0) === "\"" && str.charAt(str.length - 1) === "\"") {
      return Node(str.substring(1, str.length - 1), "string", charPos);
    }

    return Node(str, "identifier", charPos);
  }

  str = str.substring(1, str.length - 1);
  var list = [];
  var arr = str.split('');
  var matchingParen = 0;
  var insideString = false;
  var tmpString = "";
  for (var i = 0; i < str.length; i++) {
    if(arr[i] === "\"") insideString = !insideString;
    if(arr[i] === "(") matchingParen++;
    if(arr[i] === ")") matchingParen--;
    if(arr[i] === " " && !insideString && matchingParen === 0 && tmpString.length !== 0) {
      list.push(parseHelper(tmpString.trim(), 2 + charPos + i - tmpString.length));
      tmpString = "";
    }

    tmpString += arr[i];
  }
  if(tmpString.length !== 0) {
    list.push(parseHelper(tmpString.trim(), 2 + charPos + str.length - tmpString.length));
  }

  return list;
}

function evaluate(ast) {
  if(!isList(ast)) {
    if(ast.type !== "identifier") {
      return ast;
    }
    var maybeLocal = getLocal(localStack, ast.value);
    if(maybeLocal) return maybeLocal;

    if(symbolTable.hasOwnProperty(ast.value)) return Node(symbolTable[ast.value], "function", ast.charPos);

    return throwError("Undeclared identifier " + ast.value, ast);
  }
  if(ast.length === 0) return ast;

  var maybeMacro = macroTable[ast[0].value];
  if(maybeMacro) {
    return maybeMacro(ast.slice(1));
  }

  var maybeLocalMacro = getLocal(macroStack, ast[0].value);
  if(maybeLocalMacro) {
    return maybeLocalMacro.value(ast.slice(1));
  }
  var evaledAST = ast.map(evaluate);
  var func = evaledAST.shift();
  if(func.type !== "function") return throwError("Identifier '" + ast[0].value + "' isn't a function.", ast[0]);

  return func.value(evaledAST);
}

function getLocal(stack, name) {
  for (var i = stack.length - 1; i >= 0; i--) {
    if(stack[i].hasOwnProperty(name)) return stack[i][name];
  }

  return null;
}

function isList(a) {
  return a instanceof Array;
}

function Node(value, type, charPos) {
  return {
    value: value,
    type: type,
    charPos: charPos
  };
}

function prettyPrint(node) {
  if(!isList(node)) {
    switch(node.type) {
      case "identifier":
      case "boolean":
      case "number":
        return node.value.toString();
      case "function":
        return "[Function]";
      case "string":
        return "\"" + node.value + "\"";
    }
  }

  return node.reduce(function(acc, v, i) {
    return acc + prettyPrint(v) + (i !== node.length - 1 ? " " : "");
  }, "(") + ")";
}

function throwError(str, node) {
  for (;isList(node)&&node.length>0;node=node[0]);
  if (!node || isList(node)) {
    node = Node("", "", -1);
  }
  throw new Error("Error @ char " + node.charPos + ": " + str + "\nIn region: "+sourceString.substring(Math.max(0, node.charPos - 15), node.charPos - 1) + ">>" + sourceString.substring(node.charPos - 1, Math.min(sourceString.length, node.charPos + 15)));
}

function checkNumArgs(args, num) {
  if(args.length !== num) throw new Error("Improper number of arguments. Expected: " + num + ", got: " + args.length);
}

var localStack = [{}];
var macroStack = [{}];

var macroTable = {
  "define": function(args) {
    var name = args[0];
    if(name.type !== "identifier") {
      return throwError("First argument to define isn't an identifier", name);
    }

    if(symbolTable.hasOwnProperty(name.value) || macroTable.hasOwnProperty(name.value)) throwError("Reserved, can't redefine " + name.value, name);

    var res = evaluate(args[1]);
    localStack[localStack.length - 1][name.value] = res;
    return res;
  },
  "lambda": function(args) {
    var params = args[0];
    if(!isList(params)) throwError("Params should be a list of arguments.", params);

    for (var i = 0; i < params.length; i++) {
      if(isList(params[i])) throwError("Params can't be lists.", {});
    }

    var body = args[1];

    var variadicArgs = params.length > 1 && params[params.length - 1].value === "...";
    return Node(function(arr) {
      if(!variadicArgs && arr.length !== params.length) throw new Error("Improper number of arguments. Expected: " + params.length + ", got: " + arr.length);

      var map = {};
      for (var i = 0; i < params.length; i++) {
        map[params[i].value] = arr[i];
      }

      if(variadicArgs) {
        map[params[params.length - 2].value] = arr.slice(params.length - 2);
        delete map["..."];
      }
      // create a new scope for that function
      localStack.push(map);
      macroStack.push({});
      if(localStack.length > 1024) return throwError("Stack overflow > 1024", body[0]);
      var res = evaluate(body);
      localStack.pop();
      macroStack.pop();

      return res;
    }, "function", params.charPos);
  },
  "quote": function(args) {
    return args[0];
  },
  "define-macro": function(args) {
    var name = args[0];
    var body = args[1];
    var f = macroTable.lambda(body.slice(1));

    macroStack[0][name.value] = Node(function(arg) {
      return evaluate(f.value(arg));
    }, "function", name.charPos);

    return macroStack[0][name.value];
  },
  "syntax-quote": function(args) {
    var traverse = function(node) {
      if(!isList(node)) return node;

      if(node[0].value === "unquote") {
        return evaluate(node[1]);
      }

      var newTree = [];
      for (var i = 0; i < node.length; i++) {
        if(isList(node[i]) && node[i][0].value === "unquote-splice") {
          newTree = newTree.concat(evaluate(node[i][1]));
        } else newTree.push(traverse(node[i]));
      }

      return newTree;
    };
    return traverse(args[0]);
  },
  "if": function(args) {
    var bool = evaluate(args[0]);
    if(bool.type !== "boolean") throw new Error("If first argument has to evaluate to a boolean");
    if(bool.value) {
      return evaluate(args[1]);
    }
    return evaluate(args[2]);
  },
  "load": function(args) {
    var name = args[0].value;
    var data = fs.readFileSync(name + ".tmp", 'utf8').toString();
    console.log("Loading", name);
    var arr = data.split('\n');
    var rest = "";
    for (var i = 0; i < arr.length; i++) {
      var s = (rest + " " + arr[i]).trim();
      var arr2 = s.split('');
      var parens = 0;
      for (var j = 0; j < arr2.length; j++) {
        if(arr2[j] === '(') parens++;
        if(arr2[j] === ')') parens--;
      }
      if(parens < 0) throw new Error("Brackets mismatch, too many closing brackets.");

      if(parens > 0) {
        rest = s;
        continue;
      }
      rest = "";
      s = s.replace(/\n|\s+/g, " ");
      if(s.length === 0) continue;

      try {
        evaluate(parse(s));
      } catch (e) {
        console.log(e);
      }
    }
    console.log("--------------------");
    return [];
  },

};

var symbolTable = {
  "+": function(args) {
    if(args.length === 0) return [];

    return Node(args.reduce(function(acc, v) {return acc + v.value;}, 0), args[0].type, args[0].charPos);
  },
  "-": function(args) {
    if(args.length === 0) return [];

    return Node(args.reduce(function(acc, v) {return acc - v.value;}, 0), args[0].type, args[0].charPos);
  },
  "*": function(args) {
    if(args.length === 0) return [];

    return Node(args.reduce(function(acc, v) {return acc * v.value;}, 1), args[0].type, args[0].charPos);
  },
  "/": function(args) {
    if(args.length === 0) return [];

    return Node(args.reduce(function(acc, v) {return acc / v.value;}, 1), args[0].type, args[0].charPos);
  },
  "cdr": function(args) {
    checkNumArgs(args, 1);

    var rest = args[0];
    if(!isList(rest)) throw new Error("cdr expects a list as unique argument.");
    return rest.slice(1);
  },
  "car": function(args) {
    checkNumArgs(args, 1);
    var rest = args[0];
    if(!isList(rest)) throw new Error("car expects a list as unique argument.");
    return rest[0];
  },
  "cons": function(args) {
    checkNumArgs(args, 2);

    var el = args[0];
    var arr = args[1];

    if(!isList(arr)) arr = [arr];

    return [el].concat(arr);
  },
  "apply": function(args) {
    checkNumArgs(args, 2);

    var func = args[0];
    var arr = args[1];
    if(!isList(arr)) throw new Error("Second argument should be a list.");
    if(typeof func !== "function") throw new Error("First argument should be a function.");

    return func(arr);
  },
  "map": function(args) {
    if(args.length < 2) return [];

    var f = args[0];
    var rest = args.slice(1);
    var min = Infinity;
    for (var i = 1; i < args.length; i++) {
      if(args[i].length < min) {
        min = args[i].length;
      }
    }
    var ret = new Array(min);
    for (i = 0; i < min; i++) {
      var argsToFunc = new Array(rest.length);
      for (var j = 0; j < rest.length; j++) {
        argsToFunc[j] = rest[j][i];
      }
      ret[i] = f.value(argsToFunc);
    }

    return ret;
  },
  "equal?" : function(args) {
    if (args.length < 2) throwError("", args);
    for (var i = 1; i < args.length; i++){

      if (!areStructurallyEqual(args[i], args[0])) return Node(false, "boolean", -2);
    }
    return Node(true, "boolean", args);
  },
  "and": function(args) {
    for (var i = 0; i < args.length; i++){
      if (isList(args[i]) || !args[i].value) return Node(false, "boolean", -2);
    }
    return Node(true, "boolean", -2);
  },
  "debug": function(args){
    checkNumArgs(args, 2);
    console.log(args[0].value);
    return args[1];
  }
};

function areStructurallyEqual(obj1, obj2){
  if (isList(obj1) && isList(obj2)){
    if (obj1.length != obj2.length) return false;
    else {
      for (var i = 0; i < obj1.length; i++){
        if (!areStructurallyEqual(obj1[i], obj2[i])) return false;
      }
      return true;
    }
  } else {
    if (obj1.type != obj2.type) return false;
    if (obj1.value != obj2.value) return false;
    return true;
  }
}

module.exports = {
  parse: parse,
  evaluate: evaluate,
  prettyPrint: prettyPrint
};
