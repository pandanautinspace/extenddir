import React, { useEffect, useState } from 'react';

const TabList = ({ id }) => {
    return (
        <div style={{
            display: 'flex'
        }}>
            <h2>{id}</h2>
        </div>
    );
};

export default TabList;
