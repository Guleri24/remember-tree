/* -*- mode: javascript; js-indent-level: 2 -*- */
'use strict';

// Override these settings:
let familyDataFilename = "family-tree.txt"; // Your own family.txt
let defaultRootName = 'Leopold';                // Someone in your family
let lineHeight = 280;  // 220 is better, but the Simpsons pngs are very vertical

// Other rendering constants
let paddingAmount = 8;
let photoDir = 'photos/'; // should end with slash

// Rendering settings that user can change
let includeAll = false;
// 1: ancestors + siblings; 2: ancestor + cousins; Infinity: all blood relatives
let downLimit = Infinity;
let rootName = defaultRootName;

// Stateful global helpers
let imageTracker = {
    numCreated: 0, numDone: 0, allCreated: false
};

// Basic parsing functions taking a string as input
function isPerson(name) {
    return !name.includes(' + ');
}

function isUnion(name) {
    return name.includes(' + ');
}

// Input: text from familyDataFilename
// Output: "entries" = map<name of person or union, list of data rows for them>
function getEntries(text) {
    let lines = text.split('\n');
    let result = {};
    let i = 0;

    let uniqueCounter = 0; // To replace ? by unique identifiers.
    function makeUnique(str) {
        uniqueCounter += 1;
        return str + '#' + uniqueCounter;
    }

    let correctedLabel = str => (str === "?" || str === "...") ? makeUnique(str) : str;

    // skip line if comment or blank. return true iff it was a comment or blank.
    function trySkipComment() {
        if (i >= lines.length || !(lines[i].startsWith('#') || lines[i].trim() === "")) return false;
        i++;
        return true;
    }

    while (i < lines.length) {
        if (trySkipComment()) continue;
        let key = lines[i];
        let tokens = key.split(' + ');
        if (tokens.length > 2) {
            throw "Multiple + signs in union: " + key;
        }
        tokens = tokens.map(x => x.trim());
        if (tokens.includes("")) throw "Mis-formatted line " + i + ": " + key;
        if (key.includes(",")) throw "Names can't contain commas: " + key;
        if (tokens.length === 2) {
            // need to update name of union with ? so it can be referenced later
            tokens = tokens.map(correctedLabel);
            key = tokens[0] + ' + ' + tokens[1];
        } else {
            if (result.hasOwnProperty(key)) throw "Multiple entries for name: " + key;
        }
        let value = [];
        i += 1;
        while (i < lines.length && lines[i].startsWith(' ')) {
            if (trySkipComment()) continue;
            let trimmedLine = lines[i].trim();
            // should be "X: ..." where X is a limited set of characters
            // n: note. l: lifespan. c: children. p: picture.
            // if (trimmedLine.substring(1, 2) !== ": " ||

            if (isPerson(key) && !["n", "l", "p"].includes(trimmedLine[0]) || isUnion(key) && !["n", "c"].includes(trimmedLine[0])) {
                throw "Mis-formatted line under " + key + ": " + trimmedLine;
            }
            if (trimmedLine.substring(0, 3) === "c: ") {
                let children = trimmedLine.substring(3).split(", ").map(correctedLabel);
                trimmedLine = "c: " + children.join(", ");
                if (children.includes(tokens[0])) throw tokens[0] + " is listed as their own child";
                if (children.includes(tokens[1])) throw tokens[1] + " is listed as their own child";
            }
            value.push(trimmedLine);
            i += 1;
        }
        result[key] = value;
    }
    return result;
}

// Rewrite as undirected bipartite graph on people and unions
// Output: map<person or union name, list<adjacent union or person names>>
function getNeighbours(entries) {
    let result = {};
    // Ensure singleton nodes are included:
    for (let name of Object.keys(entries)) result[name] = [];

    function addHalfEdge(x, y) {
        if (!result.hasOwnProperty(x)) result[x] = [];
        result[x].push(y);
    }

    for (let [name, props] of Object.entries(entries)) {
        if (isPerson(name)) continue;
        let [p1, p2] = name.split(' + ');
        let newName = p1 + ' + ' + p2;
        let children = [];
        for (let prop of props) {
            if (prop.startsWith('c: ')) children = prop.substring(3).split(', ');
        }
        for (let x of children.concat([p1, p2])) {
            addHalfEdge(newName, x);
            addHalfEdge(x, newName);
        }
    }
    return result;
}

// Get union where this person was one of the two parents, or null if none.
// 0: left side, 1: right side
function getUnion(person, neighbours, side) {
    let result = [];
    for (let name of neighbours[person]) {
        let members = name.split(' + ');
        if (members[1 - side] === person) result.push(name);
    }
    if (result.length === 0) return null; else if (result.length === 1) return result[0]; else throw (person + ' has two unions on side ' + side);
}

function getLeftUnion(person, neighbours) {
    return getUnion(person, neighbours, 0);
}

function getRightUnion(person, neighbours) {
    return getUnion(person, neighbours, 1);
}

function getAboveUnion(person, neighbours) {
    for (let name of neighbours[person]) {
        if (!name.split(' + ').includes(person)) return name;
    }
    return null;
}

function getChildren(union, neighbours) {
    if (union === null) return [];
    return neighbours[union].filter(name => !union.split(' + ').includes(name));
}

// A layout is a map <person or union name, {x:..., y:...}>
// Here x is in pixels and y is in "generations" (lineHeight high each)

// Update layout in-place
function shift(layout, delta, sign = 1) {
    let [dx, dy] = [delta.x, delta.y]; // avoid aliasing if delta is from layout
    function move(point) {
        point.x += sign * dx;
        point.y += sign * dy;
    }

    for (let pt of Object.values(layout)) move(pt);
}

// Use "visibility" instead of "display" b/c sizes still exist
function showDiv(div, displayMode = false) {
    if (displayMode) {
        div.style.display = "block";
    } else {
        div.style.visibility = "";
    }
}

function hideDiv(div, displayMode = false) {
    if (displayMode) {
        div.style.display = "none";
    } else {
        div.style.visibility = "hidden";
    }
}

// How much space is needed from the center of this person/union to either side?
function xRadius(name, divs) {
    if (isUnion(name)) return 0;
    return paddingAmount + divs[name].offsetWidth / 2;
}

// Returns map <y, [min x, max x]>
function rowRanges(layout, divs) {
    let result = {};
    for (let [name, pt] of Object.entries(layout)) {
        let delta = xRadius(name, divs);
        let isOld = result.hasOwnProperty(pt.y);
        result[pt.y] = {
            min: Math.min(...[pt.x - delta].concat(isOld ? [result[pt.y].min] : [])),
            max: Math.max(...[pt.x + delta].concat(isOld ? [result[pt.y].max] : []))
        };
    }
    return result;
}

// Do Layouts left and right collide?
function collides(left, right, divs) {
    let layers = {};
    for (let [name, pt] of Object.entries(left).concat(Object.entries(right))) {
        if (!layers.hasOwnProperty(pt.y)) layers[pt.y] = [];
        layers[pt.y].push([pt.x - xRadius(name, divs), pt.x + xRadius(name, divs)]);
    }
    for (let [_, intervals] of Object.entries(layers)) {
        let sorted = intervals.sort((a, b) => a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]);
        for (let i = 0; i < sorted.length - 1; i++) {
            if (sorted[i][1] > sorted[i + 1][0]) return true;
        }
    }
    return false;
}

// If tryUnder, we'll try both layouts as-is.
// Otherwise, move left or right layout to fit side-by-side.
function mergedLayout(left, right, divs, moveRight = true, tryUnder = false) {
    if (tryUnder && !collides(left, right, divs)) {
        return Object.assign(left, right);
    }
    let lBounds = rowRanges(left, divs);
    let rBounds = rowRanges(right, divs);
    let shiftAge = null;
    for (let y of Object.keys(lBounds)) {
        if (rBounds.hasOwnProperty(y)) {
            let delta = lBounds[y].max - rBounds[y].min;
            shiftAge = shiftAge === null ? delta : Math.max(shiftAge, delta);
        }
    }
    if (shiftAge === null) throw "merge without common y";
    if (moveRight) shift(right, {x: shiftAge, y: 0}); else shift(left, {x: -shiftAge, y: 0});
    return Object.assign(left, right);
}

Set.prototype.union = function (setB) {
    let union = new Set(this);
    for (let elem of setB) {
        union.add(elem);
    }
    return union;
};

// returns a Set of all nodes that should be rendered
function getVisibleNodes(name, pred, neighbours, path = {allowUp: true, downsLeft: downLimit, desc: true}) {
    if (includeAll) {
        return new Set(Object.keys(neighbours));
    }
    let getNodes = function (newName, newPath) {
        if (newName === null || newName === pred) return new Set([]);
        return getVisibleNodes(newName, name, neighbours, Object.assign({}, path, newPath));
    };
    if (isPerson(name)) {
        let leftUnion = getLeftUnion(name, neighbours);
        let rightUnion = getRightUnion(name, neighbours);
        let aboveUnion = path.allowUp ? getAboveUnion(name, neighbours) : null;
        return new Set([name]).union(getNodes(aboveUnion, {desc: false})).union(getNodes(leftUnion, {allowUp: false})).union(getNodes(rightUnion, {allowUp: false}));
    } else {  // name is a union
        let [leftParent, rightParent] = name.split(' + ');
        let children = (!path.desc && path.downsLeft === 0) ? [] : getChildren(name, neighbours);
        let result = new Set([name]).union(getNodes(leftParent, {})).union(getNodes(rightParent, {}));
        for (let child of children) {
            result = result.union(getNodes(child, {allowUp: false, downsLeft: path.downsLeft - 1}));
        }
        return result;
    }
}

// returns a Layout including name, pred, and nothing beyond pred from name
// name will be at (0, 0)
function dumbLayout(name, pred, neighbours, divs, visibleNodes) {
    // Return recursive layout with name at 0, 0
    // If next==pred, return doublet Layout w/ next/pred at defaultLocation
    // (though side layouts don't need a defaultLocation due to merge shifting)
    let doLayout = function (next, defaultLocation = {x: 0, y: 0}) {
        if (next === null || !visibleNodes.has(next)) return null;
        if (next === pred) return {[name]: {x: 0, y: 0}, [next]: defaultLocation};
        let result = dumbLayout(next, name, neighbours, divs, visibleNodes);
        shift(result, result[name], -1);
        return result;
    };

    // Central layout to merge into and its default value. It is the return value.
    let mainLayout = {[name]: {x: 0, y: 0}};
    let leftLayout, rightLayout;  // These are merged into mainLayout.
    if (isPerson(name)) {
        let leftUnion = getLeftUnion(name, neighbours);
        let rightUnion = getRightUnion(name, neighbours);
        let aboveUnion = getAboveUnion(name, neighbours);
        leftLayout = doLayout(leftUnion);
        rightLayout = doLayout(rightUnion);
        let aboveLayout = doLayout(aboveUnion, {x: 0, y: -1});  // -1 is up
        if (aboveLayout !== null) mainLayout = aboveLayout;
    } else {  // name is a union
        // If union is visible, so are the members of it, but maybe not all children
        let [leftParent, rightParent] = name.split(' + ');
        let children = getChildren(name, neighbours)
            .filter(x => visibleNodes.has(x));
        leftLayout = doLayout(leftParent);
        rightLayout = doLayout(rightParent);
        let childLayouts = children.map(child => doLayout(child, {x: 0, y: 1}));
        if (childLayouts.length > 0) {
            // remove union and concatenate layouts, center, add union back
            for (let childLayout of childLayouts) delete childLayout[name];
            mainLayout = childLayouts[0];
            for (let childLayout of childLayouts.slice(1)) mainLayout = mergedLayout(mainLayout, childLayout, divs);
            let childXs = children.map(child => mainLayout[child].x);
            let middle = (Math.min(...childXs) + Math.max(...childXs)) / 2;
            shift(mainLayout, {x: -middle, y: 0});
            mainLayout[name] = {x: 0, y: 0};
        }
    }
    // common to both cases, merge side layouts into center one.
    if (leftLayout !== null) {
        delete leftLayout[name];
        mainLayout = mergedLayout(leftLayout, mainLayout, divs, false, isPerson(name));
    }
    if (rightLayout !== null) {
        delete rightLayout[name];
        mainLayout = mergedLayout(mainLayout, rightLayout, divs, true, isPerson(name));
    }
    return mainLayout;
}

function boundingBox(layout, divs) {
    function xBound(entry, sign) {
        let [name, pt] = entry;
        return pt.x + (isUnion(name) ? 0 : sign * (paddingAmount + divs[name].offsetWidth / 2));
    }

    return {
        bottomLeft: {
            x: Math.min(...Object.entries(layout).map(entry => xBound(entry, -1))),
            y: Math.min(...Object.values(layout).map(pt => pt.y))
        }, topRight: {
            x: Math.max(...Object.entries(layout).map(entry => xBound(entry, +1))),
            y: Math.max(...Object.values(layout).map(pt => pt.y))
        }
    };
}

function adjustUnions(neighbours, layout, divs) {
    for (let node of Object.keys(layout)) {
        if (!isUnion(node)) continue;
        let children = getRenderedChildren(node, neighbours, layout);
        if (children.length === 0) continue;
        let [p1, p2] = node.split(' + ');
        let parentBottom = Math.max(layout[p1].y + divs[p1].offsetHeight / 2, layout[p2].y + divs[p2].offsetHeight / 2);
        let childTop = layout[children[0]].y - divs[children[0]].offsetHeight / 2;
        for (let child of children) {
            childTop = Math.min(childTop, layout[child].y - divs[child].offsetHeight / 2);
        }
        if (childTop < parentBottom) {
            errorOut("Union " + node + " overlapped above/below. Try increasing lineHeight");
        }
        layout[node].y = (parentBottom + childTop) / 2;
    }
}

function computeLayout(neighbours, divs) {
    let visibleNodes = getVisibleNodes(rootName, null, neighbours);
    let layout = dumbLayout(rootName, null, neighbours, divs, visibleNodes);
    shift(layout, boundingBox(layout, divs).bottomLeft, -1);
    // Don't go into corner.
    shift(layout, {x: 0, y: 1});
    for (let pt of Object.values(layout)) {
        pt.y *= lineHeight;
    }
    adjustUnions(neighbours, layout, divs);
    return layout;
}

function displayName(name) {
    return name.replace(/#.*$/g, '');
}

function photoLoadCallback() {
    imageTracker.numDone++;
    imageLoadNotify();
}

function makeDiv(name, entries, neighbours) {
    let result = document.createElement("div");
    let rawName = name;
    result.onclick = function () {
        changeRoot(rawName);
    };
    result.className = "label";
    let lines = displayName(name).replace('-', '\u2011').split(" ");
    let nameDiv = document.createElement("div");
    for (let i = 0; i < lines.length; i++) {
        if (i > 0) nameDiv.appendChild(document.createElement("br"));
        nameDiv.appendChild(document.createTextNode(lines[i]));
    }
    result.appendChild(nameDiv);
    let lifespanDiv = null;
    let photoDiv = null;
    let info = [];
    if (entries[name]) {
        for (let data of entries[name]) {
            if (data.startsWith("l: ")) {
                lifespanDiv = document.createElement("div");
                let [birth, death] = data.substring(3).split('-');
                if (birth !== "") {
                    lifespanDiv.appendChild(document.createTextNode(birth + (death === '' ? '\u2013' : '')));
                }
                if (birth !== "" && death !== "") {
                    lifespanDiv.appendChild(document.createElement("br"));
                }
                if (death !== "") {
                    lifespanDiv.appendChild(document.createTextNode('\u2013' + death));
                }
                lifespanDiv.className = "lifespan";
            }
            if (data.startsWith("p: ")) {
                photoDiv = document.createElement("img");
                imageTracker.numCreated++;
                photoDiv.onload = photoDiv.onerror = photoLoadCallback;
                photoDiv.src = photoDir + data.substring(3);
                photoDiv.style.width = "70px";
                photoDiv = document.createElement("div").appendChild(photoDiv);
            }
            if (data.startsWith("n: ")) {
                info.push(data.substring(3));
            }
        }
    }

    function addMarriageInfo(partner, union) {
        let result = "";
        for (let data of entries[union]) {
            if (data.startsWith("n: ")) {
                result += data.substring(3);
            }
        }
        if (result.length === 0) return;
        info.push('With ' + displayName(partner) + ": " + result);
    }

    let leftUnion = getLeftUnion(name, neighbours);
    if (leftUnion !== null) addMarriageInfo(leftUnion.split(' + ')[0], leftUnion);
    let rightUnion = getRightUnion(name, neighbours);
    if (rightUnion !== null) addMarriageInfo(rightUnion.split(' + ')[1], rightUnion);

    if (photoDiv !== null) {
        result.appendChild(photoDiv);
    }
    if (lifespanDiv !== null) {
        result.appendChild(lifespanDiv);
    }

    function makeInfoDiv() {
        let result = document.createElement("ul");
        for (let item of info) {
            let li = document.createElement("li");
            for (let tok of item.split(/(http\S*(?=(\s|$)))/g)) {
                if (tok.startsWith('http')) {
                    let a = document.createElement("a");
                    a.appendChild(document.createTextNode(tok));
                    a.href = tok;
                    a.target = '_blank';
                    li.appendChild(a);
                } else {
                    li.appendChild(document.createTextNode(tok));
                }
            }
            result.appendChild(li);
        }
        result.classList.add('info');
        return result;
    }

    if (info.length !== 0) {
        result.classList.add('has-info');
    }
    result.onmouseover = function () {
        document.getElementById('info-pane-name').innerHTML = displayName(name);
        let details = document.getElementById('info-pane-details');
        while (details.firstChild) {
            details.removeChild(details.firstChild);
        }
        if (info.length !== 0) {
            details.appendChild(makeInfoDiv());
            showDiv(document.getElementById('info-pane'), true);
            hideDiv(document.getElementById('info-pane-placeholder'), true);
        } else {
            hideDiv(document.getElementById('info-pane'), true);
            showDiv(document.getElementById('info-pane-placeholder'), true);
        }
    };
    // For some reason size changes if not on-screen.
    document.body.appendChild(result);
    result.style.top = "200px";
    result.style.left = "200px";
    hideDiv(result);
    return result;
}

// name -> div
function makeDivs(entries, neighbours) {
    let result = {};
    for (let name of Object.keys(neighbours)) {
        if (isPerson(name)) {
            result[name] = makeDiv(name, entries, neighbours);
        }
    }
    imageTracker.allCreated = true;
    return result;
}

function placeDiv(div, x, y) {
    showDiv(div);
    div.style.top = (y - div.offsetHeight / 2) + 'px';
    div.style.left = (x - div.offsetWidth / 2) + 'px';
}

// https://stackoverflow.com/questions/4270485/drawing-lines-on-html-page
function createLine(x1, y1, x2, y2, lineClass) {
    function createLineElement(x, y, length, angle) {
        let line = document.createElement("div");
        let styles = 'border-style: solid; ' + 'width: ' + length + 'px; ' + 'height: 0px; ' + '-moz-transform: rotate(' + angle + 'rad); ' + '-webkit-transform: rotate(' + angle + 'rad); ' + '-o-transform: rotate(' + angle + 'rad); ' + '-ms-transform: rotate(' + angle + 'rad); ' + 'position: absolute; ' + 'top: ' + y + 'px; ' + 'left: ' + x + 'px; ';
        line.setAttribute('style', styles);
        line.classList.add('drawn-line');
        line.classList.add(lineClass);
        return line;
    }

    let a = x1 - x2, b = y1 - y2, c = Math.sqrt(a * a + b * b);
    let sx = (x1 + x2) / 2, sy = (y1 + y2) / 2;
    let x = sx - c / 2, y = sy;
    let alpha = Math.PI - Math.atan2(-b, a);
    return createLineElement(x, y, c, alpha);
}

function drawLine(p, q, lineClass) {
    document.body.appendChild(createLine(p.x, p.y, q.x, q.y, lineClass));
}

function getRenderedChildren(union, neighbours, layout) {
    let result = [];
    let children = getChildren(union, neighbours);
    for (let child of children) {
        if (layout.hasOwnProperty(child)) result.push(child);
    }
    return result;
}

function hasRenderedChildren(union, neighbours, layout) {
    return getRenderedChildren(union, neighbours, layout).length > 0;
}

function connect(node1, node2, layout, neighbours, divs, lineClass) {
    let [person, union] = isPerson(node1) ? [node1, node2] : [node2, node1];
    if (union.split(' + ').includes(person)) {
        // Connect person with union to a partner
        if (hasRenderedChildren(union, neighbours, layout)) {
            // Line from bottom of person
            let fudgeFixBelowParent = 4;
            drawLine({
                x: layout[person].x, y: layout[person].y + divs[person].offsetHeight / 2 - fudgeFixBelowParent
            }, {
                x: layout[union].x, y: layout[union].y
            }, lineClass);
        } else {
            // Line from side of person
            let isLeftPersonOfUnion = union.split(' + ')[0] === person;
            drawLine({
                x: layout[person].x + (isLeftPersonOfUnion ? 1 : -1) * divs[person].offsetWidth / 2, y: layout[person].y
            }, {
                x: layout[union].x, y: layout[union].y
            }, lineClass);
        }
    } else {
        // Connect person with union to a parent
        // Line from top of person
        drawLine({
            x: layout[person].x, y: layout[person].y - divs[person].offsetHeight / 2
        }, {
            x: layout[union].x, y: layout[union].y
        }, lineClass);
    }
}

function scrollToElement(element) {
    const elementRect = element.getBoundingClientRect();
    const elementMiddleY = window.pageYOffset + elementRect.top + element.offsetHeight / 2;
    const y = elementMiddleY - (window.innerHeight / 2);
    const elementMiddleX = window.pageXOffset + elementRect.left + element.offsetWidth / 2;
    const x = elementMiddleX - (window.innerWidth / 2);
    window.scrollTo(x, y - document.getElementById('control-panel').offsetHeight / 2);
    element.focus();
}

function traverse(name, pred, neighbours, divs, layout, mode, flags = {ancestor: true, descendant: true, blood: true}) {
    let posClass;
    if (pred === null) {
        posClass = "pos-root";
    } else if (flags.ancestor) {
        posClass = "pos-ancestor";
    } else if (flags.descendant) {
        posClass = "pos-descendant";
    } else if (flags.blood) {
        posClass = "pos-blood";
    } else {
        posClass = "pos-other";
    }
    if (mode === "drawConnections" && layout.hasOwnProperty(name) && layout.hasOwnProperty(pred)) {
        if (isUnion(name) && name.split(' + ').includes(pred) && getRenderedChildren(name, neighbours, layout).length === 0) {
            // Avoid half-colored links
            connect(name, pred, layout, neighbours, divs, "pos-other");
        } else {
            connect(name, pred, layout, neighbours, divs, posClass);
        }
    }

    function recur(newName, newFlags) {
        if (newName === null || newName === pred) return;
        traverse(newName, name, neighbours, divs, layout, mode, Object.assign({}, flags, newFlags));
    }

    if (isPerson(name)) {
        if (mode === "setPeopleClasses") {
            divs[name].classList.add(posClass);
        }
        let leftUnion = getLeftUnion(name, neighbours);
        recur(leftUnion, {ancestor: false, blood: flags.ancestor || flags.blood});
        let rightUnion = getRightUnion(name, neighbours);
        recur(rightUnion, {ancestor: false, blood: flags.ancestor || flags.blood});
        let aboveUnion = getAboveUnion(name, neighbours);
        recur(aboveUnion, {blood: false, descendant: false});
    } else {
        let [p1, p2] = name.split(' + ');
        recur(p1, {blood: false, descendant: false});
        recur(p2, {blood: false, descendant: false});
        for (let child of getChildren(name, neighbours)) {
            recur(child, {ancestor: false, blood: flags.ancestor || flags.blood});
        }
    }
}

function setPeopleClasses(rootName, neighbours, divs) {
    traverse(rootName, null, neighbours, divs, null, "setPeopleClasses");
}

function drawConnections(rootName, neighbours, divs, layout) {
    traverse(rootName, null, neighbours, divs, layout, "drawConnections");
}

function drawTree(divs, neighbours) {
    if (!divs[rootName]) throw "Selected name not found in data: " + rootName;
    // Since classes affect div size, do it before layout.
    setPeopleClasses(rootName, neighbours, divs);
    let layout = computeLayout(neighbours, divs);
    let box = boundingBox(layout, divs);
    shift(layout, {
        x: 0, y: 0.5 * lineHeight - box.bottomLeft.y + document.getElementById('control-panel').offsetHeight
    });
    drawConnections(rootName, neighbours, divs, layout);
    for (let name of Object.keys(neighbours)) {
        if (isPerson(name)) {
            if (layout.hasOwnProperty(name)) {
                placeDiv(divs[name], layout[name].x, layout[name].y);
            } else {
                hideDiv(divs[name]);
                // Stuck divs would make window always stay giant.
                divs[name].style.top = '100px';
                divs[name].style.left = '100px';
            }
        }
    }
    scrollToElement(divs[rootName]);
    updateTreeInformation(layout, divs);
}

function updateTreeInformation(layout, divs) {
    let infoDiv = document.getElementById('tree-information');
    let ancestors = 0, descendants = 0, blood = 0, others = 0;
    for (let [person, div] of Object.entries(divs)) {
        if (!layout.hasOwnProperty(person)) continue;
        if (div.classList.contains('pos-ancestor')) ancestors++;
        if (div.classList.contains('pos-descendant')) descendants++;
        if (div.classList.contains('pos-blood')) blood++;
        if (div.classList.contains('pos-other')) others++;
    }
    let counts = [];

    function process(number, description, textClass) {
        if (number > 0) counts.push('<span class="' + textClass + '">' + number + " " + description + "</span>");
    }

    process(descendants, "descendants", "text-descendant");
    process(ancestors, "ancestors", "text-ancestor");
    process(blood, "blood relatives", "text-blood");
    process(others, "others", "text-other");
    let result = 'Showing ';
    for (let i = 0; i < counts.length; i++) {
        result += counts[i];
        if (i === counts.length - 2) result += " and ";
        if (i < counts.length - 2) result += ", ";
    }
    result += ' (total ' + (ancestors + blood + descendants + others + 1) + ').';
    infoDiv.innerHTML = result;
}

function setLetsFromDetailOption() {
    let choice = document.getElementById('detail-picker').value;
    if (choice === 'Everyone') {
        includeAll = true;
        downLimit = Infinity;
    } else {
        includeAll = false;
        downLimit = Number(choice);
    }
}

function updateDetail() {
    setLetsFromDetailOption();
    redraw();
    document.activeElement.blur();
}

function validateTreeStructure(neighbours) {
    let parent = {};  // null parent means visited, root of its component.
    function buildConnectedComponent(curr, prev, component) {
        if (parent.hasOwnProperty(curr)) {
            // Indicates a loop. Since it's dfs it's a parent chain.
            let loop = [curr, prev];
            let unroll = prev;
            while (unroll !== curr) {
                if (unroll === null) {
                    throw "Internal validation error (file a bug!)";
                }
                unroll = parent[unroll];
                loop.push(unroll);
            }
            throw "Loop detected: " + loop;
        }
        parent[curr] = prev;
        component[curr] = true;
        for (let x of neighbours[curr]) {
            if (x === prev) continue;
            buildConnectedComponent(x, curr, component);
        }
    }

    let components = [];
    for (let name of Object.keys(neighbours)) {
        if (!neighbours.hasOwnProperty(name)) {
            throw "Singleton node or mal-formatted line: " + name;
        }
        if (parent.hasOwnProperty(name)) continue;
        let component = {};
        buildConnectedComponent(name, null, component);
        components.push([name, component]);
    }
    if (components.length > 1) {
        let msg = "Multiple connected components";
        for (let [name, component] of components) {
            msg += " | " + Object.keys(component).length + " connected to " + name;
        }
        throw msg;
    }
}

function errorOut(error) {
    console.log(error);
    alert(error);
    throw error;
}

function asyncLoadTextFile(filename, successCallback) {
    let xhr = new XMLHttpRequest();
    xhr.open("GET", filename, true);
    xhr.onload = function () {
        if (xhr.readyState === 4 && xhr.status === 200) {
            try {
                successCallback(xhr.responseText.replace(/\r/g, ''));
            } catch (error) {
                errorOut(error);
            }
        } else {
            errorOut(xhr.statusText);
        }
    };
    xhr.onerror = errorOut;
    xhr.send();
}

window.onload = function () {
    asyncLoadTextFile(familyDataFilename, processFamilyTxt);
};

function processFamilyTxt(family_txt) {
    let entries = getEntries(family_txt);
    let neighbours = getNeighbours(entries);
    validateTreeStructure(neighbours);
    let divs = makeDivs(entries, neighbours);
    // Need to save divs and neighbours, also keep entries for debugging.
    window.state = {entries, divs, neighbours};

    readHash();
    drawTree(divs, neighbours);
    window.onpopstate = function () {
        readHash();
        redraw();
    };
}

function imageLoadNotify() {
    if (imageTracker.allCreated && imageTracker.numDone === imageTracker.numCreated) {
        redraw();
    }
}

function redraw() {
    for (let div of Array.from(document.getElementsByClassName('drawn-line'))) {
        div.parentNode.removeChild(div);
    }
    for (let kind of ["root", "ancestor", "blood", "descendant", "other"]) {
        for (let el of Array.from(document.getElementsByClassName("pos-" + kind))) {
            el.classList.remove("pos-" + kind);
        }
    }
    drawTree(window.state.divs, window.state.neighbours);
    updateHash();
}

function changeRoot(person) {
    rootName = person;
    showRootName();
    redraw();
}

function updateHash() {
    window.location.hash = '#' + encodeURIComponent(rootName) + ':' + document.getElementById('detail-picker').value;
}

function showRootName() {
    document.title = displayName(rootName) + "'s Family Tree";
    document.getElementById('root-name').innerText = displayName(rootName);
}

function readHash() {
    if (window.location.hash.startsWith('#')) {
        let [name, detail] = window.location.hash.substr(1).split(':');
        rootName = decodeURIComponent(name);
        document.getElementById('detail-picker').value = detail;
    }
    setLetsFromDetailOption();
    showRootName();
}
